//! Worker-side source-clock conversion. Nothing here reads a native clock from
//! the audio callback, substitutes arrival time, or authorizes a source.
use super::position::Position;
use crate::application_audio::{
    handoff::{Reader, Rejected},
    timing::{TimedBlock, TimingError},
};
use objc2::rc::Retained;
use objc2_core_media::{CMClock, CMClockOrTimebase, CMSyncConvertTime, CMTime, CMTimeFlags};
use objc2_screen_capture_kit::SCStream;
use std::{
    marker::PhantomData,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

/// Copied first-PTS metadata. The serial output callback is the sole writer,
/// under its existing exclusive sample guard. Fields never change after ready.
#[derive(Default)]
pub(super) struct SourceOrigin {
    ready: AtomicBool,
    value: AtomicI64,
    scale: AtomicI32,
    flags: AtomicU32,
    epoch: AtomicI64,
}

impl SourceOrigin {
    pub(super) fn publish(&self, time: CMTime) {
        if self.ready.load(Ordering::Acquire) {
            return;
        }
        self.value.store(time.value, Ordering::Relaxed);
        self.scale.store(time.timescale, Ordering::Relaxed);
        self.flags.store(time.flags.0, Ordering::Relaxed);
        self.epoch.store(time.epoch, Ordering::Relaxed);
        self.ready.store(true, Ordering::Release);
    }

    pub(super) fn get(&self) -> Option<CMTime> {
        self.ready.load(Ordering::Acquire).then(|| CMTime {
            value: self.value.load(Ordering::Relaxed),
            timescale: self.scale.load(Ordering::Relaxed),
            flags: CMTimeFlags(self.flags.load(Ordering::Relaxed)),
            epoch: self.epoch.load(Ordering::Relaxed),
        })
    }
}

/// One host-clock/session correspondence, including the session's fractional
/// milliseconds. Construct outside the audio callback. This validates numbers,
/// not the host's measurement of correspondence or its uncertainty.
pub struct ClockBinding {
    session: u64,
    host_origin: CMTime,
    session_time: Duration,
}

impl ClockBinding {
    /// host_origin must describe the host clock, not the stream clock. The host
    /// must pair it with session_time for this session before invoking begin.
    /// Rust Instant alone does not establish that correspondence. Outside
    /// tests only the runtime's clock measurement constructs one, and it
    /// leaves the runtime only through acceptance, which attaches a source.
    /// The binding names a session, not that source: the caller must begin
    /// the same operation it accepted, and the transcript sink checks it.
    pub(crate) fn new(
        session: u64,
        host_origin: CMTime,
        session_time: Duration,
    ) -> Result<Self, TimingError> {
        numeric(host_origin)?;
        if host_origin.value < 0 || session_time.as_millis() > u128::from(u64::MAX) {
            return Err(TimingError::Clock);
        }
        Ok(Self {
            session,
            host_origin,
            session_time,
        })
    }

    #[cfg(test)]
    pub(crate) fn session_time_for_test(&self) -> Duration {
        self.session_time
    }

    #[cfg(test)]
    pub(crate) fn session_ms_for_test(&self, host: CMTime) -> Result<u64, TimingError> {
        self.session_position(host)?.millis()
    }

    fn session_position(&self, host: CMTime) -> Result<Position, TimingError> {
        numeric(host)?;
        // Keep both native rational timestamps and the session fraction until
        // the final floor to milliseconds. No per-packet accumulated rounding.
        let a = i128::from(host.timescale);
        let b = i128::from(self.host_origin.timescale);
        let scale = a.checked_mul(b).ok_or(TimingError::Overflow)?;
        let delta = i128::from(host.value)
            .checked_mul(b)
            .and_then(|v| v.checked_sub(i128::from(self.host_origin.value).checked_mul(a)?))
            .ok_or(TimingError::Overflow)?;
        let total = i128::try_from(self.session_time.as_nanos())
            .ok()
            .and_then(|v| v.checked_mul(scale))
            .and_then(|v| v.checked_add(delta.checked_mul(1_000_000_000)?))
            .ok_or(TimingError::Overflow)?;
        if total < 0 {
            return Err(TimingError::Clock);
        }
        let denominator = scale.checked_mul(1_000_000).ok_or(TimingError::Overflow)?;
        Position::new(total as u128, denominator as u128)
    }
}

fn numeric(time: CMTime) -> Result<(), TimingError> {
    if time.timescale <= 0
        || time.epoch != 0
        || (time.flags != CMTimeFlags::Valid
            && time.flags != (CMTimeFlags::Valid | CMTimeFlags::HasBeenRounded))
    {
        return Err(TimingError::Clock);
    }
    Ok(())
}

fn source_time(origin: CMTime, frame: u64) -> Result<CMTime, TimingError> {
    numeric(origin)?;
    // Exact sample-grid addition. Refuse an unrepresentable scale instead of
    // silently rounding the source PTS before conversion.
    let mut a = origin.timescale as i64;
    let mut b = 16_000_i64;
    while b != 0 {
        (a, b) = (b, a % b);
    }
    let factor = 16_000 / a;
    let scale = i64::from(origin.timescale)
        .checked_mul(factor)
        .ok_or(TimingError::Overflow)?;
    let value = i128::from(origin.value) * i128::from(factor)
        + i128::from(frame) * i128::from(scale / 16_000);
    Ok(CMTime {
        value: i64::try_from(value).map_err(|_| TimingError::Overflow)?,
        timescale: i32::try_from(scale).map_err(|_| TimingError::Overflow)?,
        flags: CMTimeFlags::Valid,
        epoch: 0,
    })
}

/// Source-owned samples plus an immutable, rational mapping inside this block.
/// The mapping linearly interpolates the two converted boundaries. It neither
/// resamples samples nor proves the device clock was linear inside the block.
/// Recheck timing().belongs_to before using samples or committing delayed work.
pub struct NativeBlock {
    block: TimedBlock,
    start: Position,
    end: Position,
}

impl NativeBlock {
    /// Rounded envelope, exact source frames, samples and source/session guard.
    pub fn timing(&self) -> &TimedBlock {
        &self.block
    }

    /// Converted session times of the first frame and the exclusive end.
    pub(super) fn bounds(&self) -> (Position, Position) {
        (self.start, self.end)
    }

    /// Project an absolute source-frame boundary, including the exclusive end.
    /// Split chunks must retain this original mapping instead of restarting
    /// from a rounded millisecond. Out-of-block positions (including gaps) fail.
    /// This numeric lookup does not grant source/session authority.
    pub fn frame_ms(&self, frame: u64) -> Result<u64, TimingError> {
        let audio = self.block.audio();
        let offset = frame
            .checked_sub(audio.first_frame())
            .ok_or(TimingError::Clock)?;
        let frames = (audio.samples().len() / audio.format().channels() as usize) as u64;
        self.start.interpolate(self.end, offset, frames)?.millis()
    }
}

/// Same-worker native reader. Start must be accepted before consumption; every
/// block converts its absolute source boundaries through the actual stream clock.
/// It deliberately cannot enter the nominal-rate synthetic chunker: corrected
/// endpoint times do not resample audio or prove a recognizer's internal offsets.
///
/// ```compile_fail
/// fn require_send<T: Send>() {}
/// require_send::<talkqte_lib::application_audio::native::NativeReader>();
/// ```
pub struct NativeReader {
    delivery: Delivery,
    stream: Retained<SCStream>,
    _worker: PhantomData<Rc<()>>,
}

impl NativeReader {
    pub(super) fn new(
        reader: Reader,
        stream: Retained<SCStream>,
        origin: Arc<SourceOrigin>,
        binding: ClockBinding,
    ) -> Self {
        Self {
            delivery: Delivery::new(reader, origin, binding),
            stream,
            _worker: PhantomData,
        }
    }

    /// Call beside NativeOwner::poll on the constructing worker. Missing clock,
    /// conversion failure or session change retires delivery; continue polling
    /// the owner until cleanup completes. Recheck belongs_to before using work.
    pub fn try_next(&mut self, current_session: u64) -> Result<Option<NativeBlock>, TimingError> {
        let mut clocks = None;
        self.delivery.try_next(current_session, |origin, frame| {
            // This closure runs only after the accepted-start reader guard and
            // an available packet, never in the callback or under a session lock.
            // SAFETY: stream stays on its owner worker and the OS floor is checked
            // by Selection. Only valid clock objects reach CMSyncConvertTime.
            if clocks.is_none() {
                let clock =
                    unsafe { self.stream.synchronizationClock() }.ok_or(TimingError::Clock)?;
                clocks = Some((clock, unsafe { CMClock::host_time_clock() }));
            }
            let (clock, host) = clocks.as_ref().expect("prepared clocks");
            let time = source_time(origin, frame)?;
            // Both opaque references are actual live CMClock objects.
            Ok(unsafe {
                CMSyncConvertTime(
                    time,
                    &*((&**clock as *const CMClock).cast::<CMClockOrTimebase>()),
                    &*((&**host as *const CMClock).cast::<CMClockOrTimebase>()),
                )
            })
        })
    }

    /// Queue-capacity loss, including trailing drops without a later packet.
    /// After retirement this is the last observed count, not a native loss total.
    pub fn dropped_frames(&self) -> u64 {
        self.delivery.dropped_frames()
    }
}

// Same delivery path for native clocks and deterministic memory-only tests.
struct Delivery {
    reader: Option<Reader>,
    origin: Arc<SourceOrigin>,
    binding: ClockBinding,
    terminal: Option<TimingError>,
    /// Source frame and its already-delivered rational session boundary.
    last_end: Option<(u64, Position)>,
    final_dropped_frames: u64,
}

impl Delivery {
    fn new(reader: Reader, origin: Arc<SourceOrigin>, binding: ClockBinding) -> Self {
        Self {
            reader: Some(reader),
            origin,
            binding,
            terminal: None,
            last_end: None,
            final_dropped_frames: 0,
        }
    }

    fn dropped_frames(&self) -> u64 {
        self.reader
            .as_ref()
            .map_or(self.final_dropped_frames, Reader::dropped_frames)
    }

    fn try_next(
        &mut self,
        session: u64,
        mut convert: impl FnMut(CMTime, u64) -> Result<CMTime, TimingError>,
    ) -> Result<Option<NativeBlock>, TimingError> {
        if let Some(error) = self.terminal {
            return Err(error);
        }
        let result = (|| {
            if session != self.binding.session {
                return Err(TimingError::SessionChanged);
            }
            let audio = match self
                .reader
                .as_mut()
                .expect("active reader")
                .try_next()
                .map_err(TimingError::Handoff)?
            {
                Some(audio) => audio,
                None => return Ok(None),
            };
            let origin = self.origin.get().ok_or(TimingError::Clock)?;
            let end_frame = audio
                .first_frame()
                .checked_add((audio.samples().len() / audio.format().channels() as usize) as u64)
                .ok_or(TimingError::Overflow)?;
            let mut position = |frame| {
                // Reuse the complete published fraction at shared boundaries.
                if let Some((previous_frame, previous_time)) = self.last_end {
                    if frame == previous_frame {
                        return Ok(previous_time);
                    }
                }
                self.binding.session_position(convert(origin, frame)?)
            };
            let first = audio.first_frame();
            let start = position(first)?;
            let end = position(end_frame)?;
            if !start.precedes(end)? {
                return Err(TimingError::Clock);
            }
            let gap_start = if audio.gap_frames() == 0 {
                None
            } else {
                let frame = first
                    .checked_sub(audio.gap_frames())
                    .ok_or(TimingError::Overflow)?;
                let time = position(frame)?;
                if start.precedes(time)? {
                    return Err(TimingError::Clock);
                }
                Some((frame, time))
            };
            if let Some((_, previous)) = self.last_end {
                if start.precedes(previous)?
                    || match gap_start {
                        Some((_, time)) => time.precedes(previous)?,
                        None => false,
                    }
                {
                    return Err(TimingError::Clock);
                }
            }
            let block = TimedBlock::map_with(audio, session, |frame| {
                if frame == first {
                    start.millis()
                } else if frame == end_frame {
                    end.millis()
                } else {
                    let (gap_frame, time) = gap_start.ok_or(TimingError::Clock)?;
                    if frame != gap_frame {
                        return Err(TimingError::Clock);
                    }
                    time.millis()
                }
            })?;
            // Stop can occur during clock conversion; never return usable audio
            // just because the ring's earlier cancellation check passed.
            let control = self.reader.as_ref().expect("active reader").control();
            if !block.belongs_to(session, &control) {
                return Err(TimingError::Handoff(Rejected::Cancelled));
            }
            self.last_end = Some((end_frame, end));
            Ok(Some(NativeBlock { block, start, end }))
        })();
        if let Err(error) = result {
            if error != TimingError::Handoff(Rejected::NotReady) {
                if let Some(reader) = self.reader.take() {
                    reader.control().0.cancelled.store(true, Ordering::Release);
                    self.final_dropped_frames = reader.dropped_frames();
                } // closes input; owner polls this even for a silent source
                self.terminal = Some(error);
            }
        }
        result
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::pcm::tests::time;
    use super::*;
    use crate::application_audio::{
        handoff::{Format, Input},
        Application, Capture, Control, Gate, Start,
    };
    use objc2_core_foundation::{CFAllocator, CFRetained};
    use objc2_core_media::CMTimebase;
    use std::ptr::NonNull;

    fn setup() -> (Gate, Control, Start, Input, Delivery) {
        let gate = Gate::default();
        let mut review = gate
            .review(Application::new("fictional-clock".into(), "Fictional clock".into()).unwrap())
            .unwrap();
        let control = review.control();
        let mut start = gate.approve(&mut review).unwrap();
        let (input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 2).unwrap();
        let binding = ClockBinding::new(7, time(7, 1), Duration::from_micros(250_600)).unwrap();
        let origin = Arc::new(SourceOrigin::default());
        origin.publish(time(10_000_001, 1_000_000));
        (
            gate,
            control,
            start,
            input,
            Delivery::new(reader, origin, binding),
        )
    }

    fn accept(start: Start) -> Capture<()> {
        start.run(|_, _| Ok(())).unwrap()
    }

    fn timebase(rate: f64) -> CFRetained<CMTimebase> {
        // Binding 0.3.2 does not expose the non-deprecated creation spelling.
        unsafe extern "C-unwind" {
            fn CMTimebaseCreateWithSourceClock(
                allocator: Option<&CFAllocator>,
                clock: &CMClock,
                out: *mut *mut CMTimebase,
            ) -> i32;
        }
        let mut raw = std::ptr::null_mut();
        // Memory-only timebase driven by the host; no audio, stream or clock read.
        unsafe {
            let host = CMClock::host_time_clock();
            assert_eq!(CMTimebaseCreateWithSourceClock(None, &host, &mut raw), 0);
            let base = CFRetained::from_raw(NonNull::new(raw).unwrap());
            assert_eq!(
                base.set_rate_and_anchor_time(rate, time(10, 1), time(7, 1)),
                0
            );
            base
        }
    }

    fn convert(base: &CMTimebase, origin: CMTime, frame: u64) -> Result<CMTime, TimingError> {
        let pts = source_time(origin, frame)?;
        unsafe {
            let host = CMClock::host_time_clock();
            Ok(CMSyncConvertTime(
                pts,
                &*((base as *const CMTimebase).cast::<CMClockOrTimebase>()),
                &*((&*host as *const CMClock).cast::<CMClockOrTimebase>()),
            ))
        }
    }

    /// Real blocks from memory-only packets through the delivery path, read
    /// one at a time. Each packet is (first source frame, frame count). The
    /// returned guards keep the fictional operation approved and running.
    pub(in crate::application_audio::native) fn native_blocks(
        rate: f64,
        packets: &[(u64, usize)],
    ) -> (Gate, Control, Capture<()>, Vec<NativeBlock>) {
        let (gate, control, start, mut input, mut delivery) = setup();
        let capture = accept(start);
        let base = timebase(rate);
        let blocks = packets
            .iter()
            .map(|&(first, frames)| {
                input.push(&control, first, &vec![0.25; frames]).unwrap();
                delivery
                    .try_next(7, |o, f| convert(&base, o, f))
                    .unwrap()
                    .unwrap()
            })
            .collect();
        (gate, control, capture, blocks)
    }

    /// The same delivery path for a test that supplies its own reader and
    /// clock binding, such as one accepted by the runtime. Source time 10 s
    /// corresponds to host time 7 s; the first sample is 1 µs after that.
    pub(crate) struct Feed {
        delivery: Delivery,
        base: CFRetained<CMTimebase>,
    }

    impl Feed {
        pub(crate) fn new(reader: Reader, binding: ClockBinding, rate: f64) -> Self {
            let origin = Arc::new(SourceOrigin::default());
            origin.publish(time(10_000_001, 1_000_000));
            Self {
                delivery: Delivery::new(reader, origin, binding),
                base: timebase(rate),
            }
        }

        pub(crate) fn next(&mut self, session: u64) -> Result<Option<NativeBlock>, TimingError> {
            let base = &self.base;
            self.delivery.try_next(session, |o, f| convert(base, o, f))
        }
    }

    #[test]
    fn actual_timebase_rates_preserve_source_phase_session_fraction_and_gaps() {
        for (rate, start_ms, end_ms, gap_ms) in [
            (0.5, 252, 254, 250),
            (1.0, 251, 252, 250),
            (2.0, 251, 251, 250),
        ] {
            let (_gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            let base = timebase(rate);
            // Skip the first millisecond on purpose; its gap is source time,
            // not a reason to reset the session to the first arrival.
            input.push(&control, 16, &[0.25; 16]).unwrap();
            let block = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            assert_eq!(
                (block.timing().start_ms(), block.timing().end_ms()),
                (start_ms, end_ms)
            );
            assert_eq!(block.timing().gap().unwrap().start_ms, gap_ms);
            assert_eq!(block.timing().gap().unwrap().frames, 16);
            assert_eq!(block.timing().audio().samples(), &[0.25; 16]);
            assert!(block.timing().belongs_to(7, &control));
            input.push(&control, 32, &[0.5; 16]).unwrap();
            let next = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            assert_eq!(next.timing().start_ms(), end_ms);
            assert!(next.timing().gap().is_none());
        }
    }

    #[test]
    fn every_split_frame_preserves_fractional_phase_and_native_rate() {
        for (rate, phase_ns, frame_ns) in [
            (0.5, 2_000, 125_000),
            (1.0, 1_000, 62_500),
            (2.0, 500, 31_250),
        ] {
            let (_gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            let base = timebase(rate);
            input.push(&control, 13, &[0.25; 2_048]).unwrap();
            let block = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            // Treat each boundary as a possible chunk split or recognizer offset.
            // Expected values come from the explicit fixture's clock relation.
            for frame in 13..=2_061 {
                let expected = (250_600_000 + phase_ns + frame * frame_ns) / 1_000_000;
                assert_eq!(
                    block.frame_ms(frame),
                    Ok(expected),
                    "rate {rate}, frame {frame}"
                );
            }
            assert_eq!(block.frame_ms(13), Ok(block.timing().start_ms()));
            assert_eq!(block.frame_ms(2_061), Ok(block.timing().end_ms()));
            for outside in [0, 12, 2_062, u64::MAX] {
                assert_eq!(block.frame_ms(outside), Err(TimingError::Clock));
            }
        }
    }

    #[test]
    fn fractional_shared_boundary_is_retained_after_reestimation() {
        let (_gate, control, start, mut input, mut delivery) = setup();
        let _capture = accept(start);
        let base = timebase(1.0);
        input.push(&control, 0, &[0.25; 64]).unwrap();
        let first = delivery
            .try_next(7, |o, f| convert(&base, o, f))
            .unwrap()
            .unwrap();
        unsafe {
            assert_eq!(
                base.set_rate_and_anchor_time(1.0, time(10, 1), time(7_000_100, 1_000_000)),
                0
            );
        }
        input.push(&control, 64, &[0.5; 64]).unwrap();
        let second = delivery
            .try_next(7, |o, f| convert(&base, o, f))
            .unwrap()
            .unwrap();
        assert_eq!(first.end, second.start);
        for offset in 0..=64 {
            // 4.1ms across the second block, starting at the old 254.601ms end.
            let expected = (254_601_000 + 4_100_000 * offset / 64) / 1_000_000;
            assert_eq!(second.frame_ms(64 + offset), Ok(expected));
            // Later clock changes cannot retime work already returned.
            assert_eq!(
                first.frame_ms(offset),
                Ok((250_601_000 + 62_500 * offset) / 1_000_000)
            );
        }
    }

    #[test]
    fn fractional_backwards_or_flat_block_retires_previously_returned_work() {
        for end_micros in [7_000_750, 7_001_000] {
            let (_gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            input.push(&control, 0, &[0.0; 16]).unwrap();
            let previous = delivery
                .try_next(7, |_, frame| {
                    Ok(time(7_000_000 + frame as i64 * 1_000 / 16, 1_000_000))
                })
                .unwrap()
                .unwrap();
            input.push(&control, 16, &[0.0; 16]).unwrap();
            // Both times floor to 251ms. One goes backwards, one is flat;
            // neither is a valid mapping for a nonempty block of later frames.
            assert_eq!(
                delivery
                    .try_next(7, |_, _| Ok(time(end_micros, 1_000_000)))
                    .err(),
                Some(TimingError::Clock)
            );
            assert!(control.is_cancelled());
            assert!(!previous.timing().belongs_to(7, &control));
            assert_eq!(
                delivery.try_next(7, |_, _| panic!("retired")).err(),
                Some(TimingError::Clock)
            );
        }
    }

    #[test]
    fn fractional_backwards_gap_is_rejected_before_rounding() {
        let (_gate, control, start, mut input, mut delivery) = setup();
        let _capture = accept(start);
        input.push(&control, 16, &[0.0; 16]).unwrap();
        let result = delivery.try_next(7, |_, frame| {
            Ok(time(
                match frame {
                    0 => 7_000_200, // missing range begins after the next block starts
                    16 => 7_000_100,
                    32 => 7_000_300,
                    _ => unreachable!(),
                },
                1_000_000,
            ))
        });
        assert_eq!(result.err(), Some(TimingError::Clock));
        assert!(control.is_cancelled());
    }

    #[test]
    fn pending_start_and_empty_ring_do_not_query_native_clocks() {
        let (_gate, control, start, mut input, mut delivery) = setup();
        input.push(&control, 0, &[0.0; 16]).unwrap();
        assert_eq!(
            delivery
                .try_next(7, |_, _| panic!("clock before start"))
                .err(),
            Some(TimingError::Handoff(Rejected::NotReady))
        );
        let _capture = accept(start);
        let base = timebase(1.0);
        delivery
            .try_next(7, |o, f| convert(&base, o, f))
            .unwrap()
            .unwrap();
        assert!(delivery
            .try_next(7, |_, _| panic!("clock without audio"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn reestimated_clock_keeps_adjacent_packets_continuous() {
        for host_micros in [6_999_000, 7_001_000] {
            let (_gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            let base = timebase(1.0);
            input.push(&control, 0, &[0.25; 64]).unwrap();
            let first = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            // Re-estimate the same source/host relationship between packets.
            // This is an actual memory timebase update, not a fixed fake clock.
            unsafe {
                assert_eq!(
                    base.set_rate_and_anchor_time(1.0, time(10, 1), time(host_micros, 1_000_000)),
                    0
                );
            }
            input.push(&control, 64, &[0.5; 64]).unwrap();
            let second = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            assert_eq!(second.timing().start_ms(), first.timing().end_ms());
            assert!(second.timing().gap().is_none());
            assert!(second.timing().end_ms() > second.timing().start_ms());
            assert_eq!(second.timing().audio().samples(), &[0.5; 64]);
            assert!(!control.is_cancelled());
        }
    }

    #[test]
    fn reestimated_clock_keeps_gap_start_at_delivered_boundary() {
        for host_micros in [6_999_000, 7_001_000] {
            let (_gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            let base = timebase(1.0);
            input.push(&control, 0, &[0.25; 64]).unwrap();
            let first = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            unsafe {
                assert_eq!(
                    base.set_rate_and_anchor_time(1.0, time(10, 1), time(host_micros, 1_000_000)),
                    0
                );
            }
            input.push(&control, 128, &[0.5; 64]).unwrap();
            let second = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            let gap = second.timing().gap().unwrap();
            assert_eq!(gap.frames, 64);
            assert_eq!(gap.start_ms, first.timing().end_ms());
            assert_eq!(gap.end_ms, second.timing().start_ms());
            assert!(gap.end_ms > gap.start_ms);
        }
    }

    #[test]
    fn stop_during_conversion_and_changed_session_permanently_retire_delivery() {
        let (gate, control, start, mut input, mut delivery) = setup();
        let _capture = accept(start);
        input.push(&control, 0, &[0.0; 16]).unwrap();
        let base = timebase(1.0);
        let mut stopped = false;
        let result = delivery.try_next(7, |o, f| {
            if !stopped {
                gate.stop(&control).unwrap();
                stopped = true;
            }
            convert(&base, o, f)
        });
        assert_eq!(
            result.err(),
            Some(TimingError::Handoff(Rejected::Cancelled))
        );
        assert!(delivery.try_next(7, |_, _| panic!("retired")).is_err());

        let (_gate, control, start, mut input, mut delivery) = setup();
        let _capture = accept(start);
        input.push(&control, 0, &[0.0; 16]).unwrap();
        let previous = delivery
            .try_next(7, |o, f| convert(&base, o, f))
            .unwrap()
            .unwrap();
        assert_eq!(
            delivery.try_next(8, |_, _| panic!("new session")).err(),
            Some(TimingError::SessionChanged)
        );
        assert!(!previous.timing().belongs_to(7, &control));
        assert_eq!(
            delivery.try_next(7, |_, _| panic!("old session")).err(),
            Some(TimingError::SessionChanged)
        );
    }

    #[test]
    fn missing_clock_invalid_conversion_and_backwards_time_cancel_previous_work() {
        for scenario in 0..5 {
            let (_gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            let base = timebase(1.0);
            input.push(&control, 0, &[0.0; 16]).unwrap();
            let previous = delivery
                .try_next(7, |o, f| convert(&base, o, f))
                .unwrap()
                .unwrap();
            input.push(&control, 16, &[0.0; 16]).unwrap();
            let result = delivery.try_next(7, |_, _| match scenario {
                0 => Err(TimingError::Clock), // nullable stream clock
                1 => {
                    let mut t = time(7, 1);
                    t.flags = CMTimeFlags::empty();
                    Ok(t)
                }
                2 => Ok(time(7, 1)), // goes backwards from previous end
                3 => Ok(time(6, 1)), // before this session's beginning
                _ => {
                    let mut t = time(7, 1);
                    t.epoch = 1;
                    Ok(t)
                }
            });
            assert_eq!(result.err(), Some(TimingError::Clock));
            assert!(control.is_cancelled());
            assert!(!previous.timing().belongs_to(7, &control));
            assert_eq!(
                delivery.try_next(7, |_, _| panic!("retired")).err(),
                Some(TimingError::Clock)
            );
        }
    }

    #[test]
    fn invalid_anchor_or_unrepresentable_sample_time_is_refused() {
        for t in [time(-1, 1), time(1, 0)] {
            assert!(ClockBinding::new(7, t, Duration::ZERO).is_err());
        }
        assert!(ClockBinding::new(7, time(7, 1), Duration::MAX).is_err());
        assert!(source_time(time(1, i32::MAX), 1).is_err());
        assert!(source_time(time(i64::MAX, 16_000), 1).is_err());
        let binding = ClockBinding::new(7, time(7, 1), Duration::from_millis(u64::MAX)).unwrap();
        assert_eq!(
            binding.session_ms_for_test(time(8, 1)),
            Err(TimingError::Overflow)
        );
        assert_eq!(binding.session_ms_for_test(time(7, 1)), Ok(u64::MAX));
    }

    #[test]
    fn trailing_queue_loss_remains_observable_after_stop_error_and_eof() {
        for terminal in 0..3 {
            let (gate, control, start, mut input, mut delivery) = setup();
            let _capture = accept(start);
            input.push(&control, 0, &[0.0; 16]).unwrap();
            input.push(&control, 16, &[0.0; 16]).unwrap();
            assert_eq!(input.push(&control, 32, &[0.0; 16]), Err(Rejected::Full));
            assert_eq!(delivery.dropped_frames(), 16);
            let base = timebase(1.0);
            match terminal {
                0 => {
                    gate.stop(&control).unwrap();
                    assert_eq!(
                        delivery.try_next(7, |_, _| panic!("stopped")).err(),
                        Some(TimingError::Handoff(Rejected::Cancelled))
                    );
                }
                1 => {
                    assert_eq!(
                        delivery.try_next(7, |_, _| Err(TimingError::Clock)).err(),
                        Some(TimingError::Clock)
                    );
                }
                _ => {
                    drop(input);
                    for _ in 0..2 {
                        delivery
                            .try_next(7, |o, f| convert(&base, o, f))
                            .unwrap()
                            .unwrap();
                    }
                    assert_eq!(
                        delivery.try_next(7, |_, _| panic!("closed")).err(),
                        Some(TimingError::Handoff(Rejected::Closed))
                    );
                }
            }
            assert_eq!(delivery.dropped_frames(), 16);
            assert!(delivery.try_next(7, |_, _| panic!("retired")).is_err());
            assert_eq!(delivery.dropped_frames(), 16);
        }
    }
}
