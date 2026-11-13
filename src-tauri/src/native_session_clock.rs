//! Private preparation for the disconnected native audio experiment. Snapshot
//! under Runtime, measure on its owning worker, then validate under Runtime.
//! Acceptance attaches the source to the live session, so that session's Stop
//! or replacement cancels it. No command calls this yet; it neither starts
//! capture nor grants permission.
#![allow(dead_code)]

use crate::{
    application_audio::{native::ClockBinding, timing::TimingError, Control},
    live_source::Refused,
    Runtime,
};
use objc2_core_media::{CMClock, CMTime};
use std::time::{Duration, Instant};

pub(crate) struct Snapshot {
    session: u64,
    operation: String,
    control: Control,
    at: Instant,
    elapsed: Duration,
}

pub(crate) struct Measurement {
    snapshot: Snapshot,
    binding: ClockBinding,
    width: Duration,
    measured_at: Instant,
    max_age: Duration,
}

/// The full read bracket, not a device drift estimate or a confidence interval.
/// The host must retain it with its acceptance evidence. This correspondence
/// does not authorize capture or replace ongoing source/session guards.
pub(crate) struct MeasuredBinding {
    /// The live session the source is now attached to.
    pub session: u64,
    pub binding: ClockBinding,
    pub bracket_width: Duration,
}

impl Runtime {
    /// Call with the Runtime mutex held. This method never invokes an SDK.
    pub(crate) fn native_clock_snapshot(
        &mut self,
        control: &Control,
    ) -> Result<Snapshot, TimingError> {
        self.native_clock_snapshot_at(control, Instant::now())
    }

    fn native_clock_snapshot_at(
        &mut self,
        control: &Control,
        now: Instant,
    ) -> Result<Snapshot, TimingError> {
        // Refuse a reversed injected/observed Rust clock instead of letting
        // duration_since saturate it to zero in the ordinary runtime sync.
        now.checked_duration_since(self.last_tick)
            .ok_or(TimingError::Clock)?;
        self.sync_at(now);
        let operation = self.native_clock_operation()?.to_owned();
        if control.is_cancelled() {
            return Err(TimingError::SessionChanged);
        }
        Ok(Snapshot {
            session: self.engine.session(),
            operation,
            control: control.clone(),
            at: self.last_tick,
            elapsed: Duration::from_millis(self.engine.state.elapsed_ms)
                .checked_add(self.tick_remainder)
                .ok_or(TimingError::Overflow)?,
        })
    }

    fn native_clock_operation(&self) -> Result<&str, TimingError> {
        self.live_source_operation()
            .ok_or(TimingError::SessionChanged)
    }

    /// Reacquire Runtime after measurement; no native work occurs here. Consume
    /// the measurement once. Success attaches the source to this live session:
    /// from then on the session's Stop or replacement cancels the source under
    /// this lock. One binding per source operation and one source at a time;
    /// a second acceptance is refused as Occupied, which is not a reason to
    /// stop the attached source, and leaves it running.
    /// The native owner and every delivered block keep their control checks.
    pub(crate) fn accept_native_clock(
        &mut self,
        measurement: Measurement,
    ) -> Result<MeasuredBinding, TimingError> {
        self.accept_native_clock_at(measurement, Instant::now())
    }

    fn accept_native_clock_at(
        &mut self,
        measurement: Measurement,
        now: Instant,
    ) -> Result<MeasuredBinding, TimingError> {
        let snapshot = &measurement.snapshot;
        if snapshot.session != self.engine.session()
            || self.native_clock_operation()? != snapshot.operation
            || snapshot.control.is_cancelled()
        {
            return Err(TimingError::SessionChanged);
        }
        // Include the runtime queue/lock wait in the same age budget. A read
        // with a narrow bracket must not refresh an old snapshot's lifetime.
        now.checked_duration_since(measurement.measured_at)
            .ok_or(TimingError::Clock)?;
        now.checked_duration_since(self.last_tick)
            .ok_or(TimingError::Clock)?;
        snapshot.check_age(now, measurement.max_age)?;
        // Last, so a rejected measurement never occupies the session.
        self.attach_live_source(&snapshot.control)
            .map_err(|refused| match refused {
                Refused::SessionChanged => TimingError::SessionChanged,
                Refused::Occupied => TimingError::Occupied,
            })?;
        Ok(MeasuredBinding {
            session: snapshot.session,
            binding: measurement.binding,
            bracket_width: measurement.width,
        })
    }
}

impl Snapshot {
    /// Call on the native owner worker, with NO Runtime mutex held. One bounded
    /// attempt only. Both limits are explicit host policy, not proven budgets.
    /// max_age runs from snapshot through acceptance; it is not renewed by the
    /// read and does not establish validity after acceptance or across sleep.
    pub(crate) fn measure(
        self,
        max_width: Duration,
        max_age: Duration,
    ) -> Result<Measurement, TimingError> {
        self.measure_with(max_width, max_age, Instant::now, || {
            // SAFETY: the framework's singleton host clock is valid for this
            // synchronous read. No capture object or borrowed callback is used.
            unsafe { CMClock::host_time_clock().time() }
        })
    }

    fn check_age(&self, now: Instant, max_age: Duration) -> Result<Duration, TimingError> {
        let age = now
            .checked_duration_since(self.at)
            .ok_or(TimingError::Clock)?;
        if age > max_age {
            return Err(TimingError::Clock);
        }
        Ok(age)
    }

    fn measure_with(
        self,
        max_width: Duration,
        max_age: Duration,
        mut now: impl FnMut() -> Instant,
        read_host: impl FnOnce() -> CMTime,
    ) -> Result<Measurement, TimingError> {
        if self.control.is_cancelled() {
            return Err(TimingError::SessionChanged);
        }
        let before = now();
        let delay = self.check_age(before, max_age)?;
        let host = read_host();
        let after = now();
        if self.control.is_cancelled() {
            return Err(TimingError::SessionChanged);
        }
        let width = after
            .checked_duration_since(before)
            .ok_or(TimingError::Clock)?;
        if width > max_width {
            return Err(TimingError::Clock);
        }
        self.check_age(after, max_age)?;
        // Preserve fractional milliseconds and scheduling delay. The host read
        // occurred somewhere in this bracket; the midpoint is only an estimate.
        let midpoint = self
            .elapsed
            .checked_add(delay)
            .and_then(|t| t.checked_add(width / 2))
            .ok_or(TimingError::Overflow)?;
        let binding = ClockBinding::new(self.session, host, midpoint)?;
        Ok(Measurement {
            snapshot: self,
            binding,
            width,
            measured_at: after,
            max_age,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::application_audio::{
        chunks::ChunkError,
        handoff::{Format, Rejected},
        native::{Feed, NativeChunker},
        Application, Gate, Review,
    };
    use crate::transcription::{AudioChunk, Recognized, Transcriber, Worker};
    use objc2_core_media::CMTimeFlags;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    };

    fn setup() -> (Runtime, Gate, Review, Control) {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
        drop(ticket);
        let gate = Gate::default();
        let review = gate
            .review(Application::new("fictional".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let control = review.control();
        (runtime, gate, review, control)
    }

    fn host() -> CMTime {
        CMTime {
            value: 17,
            timescale: 1,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        }
    }

    fn measured(
        snapshot: Snapshot,
        before: Instant,
        after: Instant,
        max: Duration,
    ) -> Result<Measurement, TimingError> {
        let mut times = [before, after].into_iter();
        snapshot.measure_with(max, Duration::from_secs(1), || times.next().unwrap(), host)
    }

    #[test]
    fn fractional_snapshot_and_delayed_worker_keep_full_bracket() {
        let (mut runtime, _gate, _review, control) = setup();
        let origin = runtime.last_tick;
        let at = origin + Duration::from_micros(1_750);
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        assert_eq!(snapshot.elapsed, Duration::from_micros(1_750));
        let before = at + Duration::from_micros(10_000);
        let measurement = measured(
            snapshot,
            before,
            before + Duration::from_nanos(501),
            Duration::from_nanos(501),
        )
        .unwrap();
        // Check the actual binding by mapping its host origin through the same
        // rational conversion used by native delivery, without a native stream.
        assert_eq!(measurement.binding.session_ms_for_test(host()).unwrap(), 11);
        assert_eq!(
            measurement.binding.session_time_for_test(),
            Duration::from_nanos(11_750_250)
        );
        runtime.sync_at(before + Duration::from_millis(1));
        let accepted = runtime
            .accept_native_clock_at(measurement, runtime.last_tick)
            .unwrap();
        assert_eq!(accepted.bracket_width, Duration::from_nanos(501));
    }

    #[test]
    fn invalid_brackets_and_clock_values_never_produce_a_binding() {
        for case in 0..6 {
            let (mut runtime, _gate, _review, control) = setup();
            let at = runtime.last_tick;
            let mut snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
            let (before, after) = match case {
                0 => (at, at + Duration::from_millis(2)),
                1 => (at + Duration::from_millis(1), at),
                2 => (at - Duration::from_millis(1), at),
                _ => (at, at + Duration::from_micros(1)),
            };
            if case == 3 {
                snapshot.elapsed = Duration::MAX;
            }
            let mut times = [before, after].into_iter();
            let result = snapshot.measure_with(
                Duration::from_millis(1),
                Duration::from_secs(1),
                || times.next().unwrap(),
                || {
                    let mut value = host();
                    if case == 4 {
                        value.flags = CMTimeFlags::empty();
                    }
                    if case == 5 {
                        value.value = -1;
                    }
                    value
                },
            );
            assert!(result.is_err(), "case {case}");
        }
    }

    #[test]
    fn stop_or_replacement_during_read_or_before_acceptance_rejects_measurement() {
        for case in 0..5 {
            let (mut runtime, gate, _review, control) = setup();
            let at = runtime.last_tick;
            let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
            let measurement = snapshot.measure_with(
                Duration::ZERO,
                Duration::from_secs(1),
                || at,
                || {
                    match case {
                        0 => {
                            runtime.take_live_for_stop();
                        }
                        1 => {
                            gate.stop(&control).unwrap();
                        }
                        2 => {
                            runtime.take_live_for_stop();
                            runtime.engine.end();
                            let ticket = runtime.begin_live_start().unwrap();
                            runtime.install_live_start(&ticket).unwrap();
                        }
                        _ => {}
                    }
                    host()
                },
            );
            if case == 1 {
                assert!(matches!(measurement, Err(TimingError::SessionChanged)));
                continue;
            }
            if case == 3 {
                runtime.engine.begin_live_stop();
            }
            if case == 4 {
                gate.stop(&control).unwrap();
            }
            assert!(matches!(
                runtime.accept_native_clock(measurement.unwrap()),
                Err(TimingError::SessionChanged)
            ));
        }
    }

    #[test]
    fn cancelled_source_skips_native_read_and_reversed_snapshot_is_rejected() {
        let (mut runtime, gate, _review, control) = setup();
        let at = runtime.last_tick;
        assert!(matches!(
            runtime.native_clock_snapshot_at(&control, at - Duration::from_nanos(1)),
            Err(TimingError::Clock)
        ));
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        gate.stop(&control).unwrap();
        assert!(matches!(
            snapshot.measure_with(
                Duration::ZERO,
                Duration::from_secs(1),
                || at,
                || panic!("cancelled read")
            ),
            Err(TimingError::SessionChanged)
        ));
        assert!(runtime.native_clock_snapshot_at(&control, at).is_err());
    }

    #[test]
    fn expired_snapshot_never_calls_the_host_clock() {
        let (mut runtime, _gate, _review, control) = setup();
        let at = runtime.last_tick;
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        let result = snapshot.measure_with(
            Duration::from_millis(1),
            Duration::from_millis(10),
            || at + Duration::from_millis(10) + Duration::from_nanos(1),
            || panic!("expired snapshot must not query the host clock"),
        );
        assert!(matches!(result, Err(TimingError::Clock)));
    }

    #[test]
    fn narrow_read_cannot_extend_the_snapshot_budget() {
        let (mut runtime, _gate, _review, control) = setup();
        let at = runtime.last_tick;
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        let mut times = [
            at + Duration::from_millis(10),
            at + Duration::from_millis(10) + Duration::from_nanos(1),
        ]
        .into_iter();
        // The one-nanosecond read meets its own width budget, but crosses the
        // total snapshot-age limit. A new short read cannot reset that limit.
        let result = snapshot.measure_with(
            Duration::from_millis(1),
            Duration::from_millis(10),
            || times.next().unwrap(),
            host,
        );
        assert!(matches!(result, Err(TimingError::Clock)));
    }

    #[test]
    fn runtime_wait_counts_toward_age_and_acceptance_cannot_reverse_time() {
        for case in 0..4 {
            let (mut runtime, _gate, _review, control) = setup();
            let at = runtime.last_tick;
            let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
            let mut times =
                [at + Duration::from_millis(2), at + Duration::from_millis(3)].into_iter();
            let measurement = snapshot
                .measure_with(
                    Duration::from_millis(1),
                    Duration::from_millis(10),
                    || times.next().unwrap(),
                    host,
                )
                .unwrap();
            let accept_at = match case {
                0 => at + Duration::from_millis(10),
                1 => at + Duration::from_millis(10) + Duration::from_nanos(1),
                2 => at + Duration::from_millis(3) - Duration::from_nanos(1),
                _ => {
                    runtime.sync_at(at + Duration::from_millis(8));
                    at + Duration::from_millis(7)
                }
            };
            let result = runtime.accept_native_clock_at(measurement, accept_at);
            if case == 0 {
                // Age equality is accepted without rounding to milliseconds.
                assert_eq!(result.unwrap().bracket_width, Duration::from_millis(1));
            } else {
                assert!(matches!(result, Err(TimingError::Clock)), "case {case}");
            }
        }
    }

    /// Host time 7 s is where the memory-only test timebase places source
    /// time 10 s, so an accepted binding maps the fictional feed's samples.
    pub(crate) fn accepted(
        runtime: &mut Runtime,
        control: &Control,
    ) -> Result<MeasuredBinding, TimingError> {
        let at = runtime.last_tick;
        let snapshot = runtime.native_clock_snapshot_at(control, at)?;
        let measurement = snapshot.measure_with(
            Duration::ZERO,
            Duration::from_secs(1),
            || at,
            || CMTime { value: 7, ..host() },
        )?;
        runtime.accept_native_clock_at(measurement, at)
    }

    #[test]
    fn acceptance_attaches_one_source_once_and_a_rejected_measurement_attaches_none() {
        let (mut runtime, gate, _review, control) = setup();
        let at = runtime.last_tick;
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        let expired = snapshot
            .measure_with(Duration::ZERO, Duration::from_millis(10), || at, host)
            .unwrap();
        assert!(matches!(
            runtime.accept_native_clock_at(expired, at + Duration::from_millis(11)),
            Err(TimingError::Clock)
        ));
        assert!(runtime.live_source.is_none() && !control.is_cancelled());

        assert!(accepted(&mut runtime, &control).is_ok());
        // Neither a second binding for this source nor another source's
        // binding is accepted, and the attached source keeps running.
        let other_gate = Gate::default();
        let other = other_gate
            .review(Application::new("other".into(), "Fictional player".into()).unwrap())
            .unwrap();
        for candidate in [control.clone(), other.control()] {
            assert!(matches!(
                accepted(&mut runtime, &candidate),
                Err(TimingError::Occupied)
            ));
        }
        assert!(!control.is_cancelled() && !other.control().is_cancelled());

        // The source stops by itself; the session then takes the other one.
        gate.stop(&control).unwrap();
        assert!(accepted(&mut runtime, &other.control()).is_ok());
        runtime.take_live_for_stop().unwrap();
        assert!(other.control().is_cancelled());
    }

    struct Recognizer {
        calls: Arc<AtomicU64>,
        started: mpsc::Sender<()>,
        open: mpsc::Receiver<()>,
    }

    impl Transcriber for Recognizer {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let _ = self.started.send(());
            let _ = self.open.recv();
            Ok(vec![Recognized {
                offset_ms: 100,
                speaker: "Speaker 1".into(),
                text: "A fictional line.".into(),
            }])
        }
    }

    #[test]
    fn live_stop_after_acceptance_stops_delivery_chunks_and_recognition_in_progress() {
        let (mut runtime, gate, mut review, control) = setup();
        let session = runtime.engine.session();
        let mut start = gate.approve(&mut review).unwrap();
        let (mut input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 2).unwrap();
        let binding = accepted(&mut runtime, &control).unwrap().binding;
        let _capture = start.run(|_, _| Ok(())).unwrap();
        let mut feed = Feed::new(reader, binding, 1.0);
        let mut chunker = NativeChunker::new(control.clone(), session);

        // 24 fictional blocks fill one three-second chunk and leave a
        // remainder pending in the chunker.
        let mut ready = Vec::new();
        for i in 0..24 {
            input.push(&control, i * 2_048, &[0.25; 2_048]).unwrap();
            let block = feed.next(session).unwrap().unwrap();
            ready.extend(chunker.push(block, session).unwrap());
        }
        assert_eq!(ready.len(), 1);
        let chunk = ready.remove(0);
        // The accepted binding placed the first sample 1 µs into the session.
        assert_eq!(chunk.session_ms(1_000), Ok(1_000));
        assert!(chunk.belongs_to(session, &control));

        let calls = Arc::new(AtomicU64::new(0));
        let (started, recognizing) = mpsc::channel();
        let (open, opened) = mpsc::channel();
        let (report, delivered) = mpsc::channel();
        let worker = Worker::start(
            session,
            4,
            Recognizer {
                calls: calls.clone(),
                started,
                open: opened,
            },
            move |_, segment: crate::engine::Segment| {
                let _ = report.send(segment.at_ms);
                Ok(())
            },
        );
        assert!(worker.submit(chunk).is_ok());
        // The recognizer holds the first chunk.
        recognizing.recv_timeout(Duration::from_secs(5)).unwrap();
        // One more block is with the worker and one packet is still queued.
        input.push(&control, 24 * 2_048, &[0.25; 2_048]).unwrap();
        let returned = feed.next(session).unwrap().unwrap();
        input.push(&control, 25 * 2_048, &[0.25; 2_048]).unwrap();

        // The live session's own Stop, not the source's gate.
        runtime.take_live_for_stop().unwrap();

        assert_eq!(
            input.push(&control, 26 * 2_048, &[0.25; 2_048]),
            Err(Rejected::Cancelled)
        );
        let cancelled = TimingError::Handoff(Rejected::Cancelled);
        assert_eq!(feed.next(session).err(), Some(cancelled));
        assert!(!returned.timing().belongs_to(session, &control));
        assert_eq!(
            chunker.push(returned, session).err(),
            Some(ChunkError::Timing(cancelled))
        );
        assert_eq!(
            chunker.finish(session).err(),
            Some(ChunkError::Timing(cancelled)),
            "the pending remainder is discarded, not flushed"
        );
        open.send(()).unwrap();
        let stats = worker.finish(Duration::from_secs(5));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!((stats.chunks, stats.accepted, stats.stale), (1, 0, 1));
        assert!(delivered.try_recv().is_err());
        // The engine session id is unchanged while Stop drains, which is why
        // the session number alone could not have refused this work.
        assert_eq!(runtime.engine.session(), session);
        assert!(!runtime.live_source_accepts(session, &control));
        assert!(matches!(
            accepted(&mut runtime, &control),
            Err(TimingError::SessionChanged)
        ));
    }

    #[test]
    fn demo_ended_stopping_and_wrong_operation_refused_but_cue_pause_runs() {
        for case in 0..6 {
            let (mut runtime, _gate, _review, control) = setup();
            let at = runtime.last_tick;
            match case {
                0 => {
                    runtime.engine = crate::Engine::default();
                    runtime.engine.start().unwrap();
                }
                1 => runtime.engine.end(),
                2 => runtime.engine.begin_live_stop(),
                3 => runtime.live.as_mut().unwrap().operation = Some("different".into()),
                4 => runtime.live.as_mut().unwrap().session += 1,
                _ => runtime.engine.set_live_cues_paused(true).unwrap(),
            }
            let snapshot =
                runtime.native_clock_snapshot_at(&control, at + Duration::from_micros(750));
            if case == 5 {
                let snapshot = snapshot.unwrap();
                assert_eq!(snapshot.elapsed, Duration::from_micros(750));
                let measurement = measured(
                    snapshot,
                    at + Duration::from_millis(1),
                    at + Duration::from_millis(1),
                    Duration::ZERO,
                )
                .unwrap();
                assert!(runtime
                    .accept_native_clock_at(measurement, at + Duration::from_millis(1))
                    .is_ok());
            } else {
                assert!(
                    matches!(snapshot, Err(TimingError::SessionChanged)),
                    "case {case}"
                );
            }
        }
    }
}
