//! Offline, source-bound audio handoff. Construct on a worker after approval;
//! no native adapter, clock conversion, resampling or transcription is supplied.

use super::{Application, Control, Start};
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

/// Fixed per-callback copy limit, not a claim about a native device format.
pub const MAX_SAMPLES: usize = 2_048;
pub const MAX_BLOCKS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejected {
    InvalidFormat,
    InvalidCapacity,
    AlreadyCreated,
    NotReady,
    InvalidBuffer,
    OutOfOrder,
    ForeignSource,
    Cancelled,
    Full,
    Closed,
}

/// One immutable interleaved format per operation. A format or clock reset
/// requires a newly reviewed operation; it cannot silently relabel old audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    sample_rate: u32,
    channels: u16,
}

impl Format {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, Rejected> {
        if !(8_000..=192_000).contains(&sample_rate) || !(1..=8).contains(&channels) {
            return Err(Rejected::InvalidFormat);
        }
        Ok(Self {
            sample_rate,
            channels,
        })
    }

    pub fn sample_rate(self) -> u32 {
        self.sample_rate
    }

    pub fn channels(self) -> u16 {
        self.channels
    }
}

// No heap-owned payload or destructor runs in the callback when a push fails.
struct Packet {
    first_frame: u64,
    len: usize,
    samples: [f32; MAX_SAMPLES],
}

impl Start {
    /// Allocate a fixed ring on the startup worker, after exact-source approval.
    /// The adapter must keep both endpoints within this capture's lifetime and
    /// only start its consumer after Start::run accepts the returned resource.
    /// One queue is allowed per approved operation.
    pub fn handoff(&mut self, format: Format, blocks: usize) -> Result<(Input, Reader), Rejected> {
        if self.lease.control.is_cancelled() {
            return Err(Rejected::Cancelled);
        }
        if self.handoff_created {
            return Err(Rejected::AlreadyCreated);
        }
        if !(1..=MAX_BLOCKS).contains(&blocks) {
            return Err(Rejected::InvalidCapacity);
        }
        let (producer, consumer) = RingBuffer::new(blocks);
        self.handoff_created = true;
        let dropped = Arc::new(AtomicU64::new(0));
        Ok((
            Input {
                producer,
                control: self.lease.control.clone(),
                format,
                next_frame: 0,
                dropped_frames: 0,
                dropped: dropped.clone(),
            },
            Reader {
                consumer,
                control: self.lease.control.clone(),
                format,
                next_frame: 0,
                dropped,
            },
        ))
    }
}

/// Single producer. Pass borrowed native samples; no allocation, mutex,
/// waiting, logging, I/O or inference occurs in push. Oversized callbacks must
/// be split by the adapter at complete frame boundaries with correct positions.
pub struct Input {
    producer: Producer<Packet>,
    control: Control,
    format: Format,
    next_frame: u64,
    dropped_frames: u64,
    dropped: Arc<AtomicU64>,
}

impl Input {
    /// first_frame is an absolute frame position on this operation's fixed-rate
    /// clock, starting at zero. It must include missing frames; never derive it
    /// from successfully queued samples. A trusted adapter must bind source to
    /// the actual native filter; this token is not proof of OS provenance.
    pub fn push(
        &mut self,
        source: &Control,
        first_frame: u64,
        samples: &[f32],
    ) -> Result<(), Rejected> {
        if self.control.is_cancelled() {
            return Err(Rejected::Cancelled);
        }
        if !Arc::ptr_eq(&self.control.0, &source.0) {
            return Err(Rejected::ForeignSource);
        }
        if self.producer.is_abandoned() {
            return Err(Rejected::Closed);
        }
        let channels = self.format.channels as usize;
        if samples.is_empty()
            || samples.len() > MAX_SAMPLES
            || !samples.len().is_multiple_of(channels)
            || samples.iter().any(|v| !v.is_finite())
        {
            return Err(Rejected::InvalidBuffer);
        }
        let frames = (samples.len() / channels) as u64;
        let end = first_frame
            .checked_add(frames)
            .ok_or(Rejected::InvalidBuffer)?;
        if first_frame < self.next_frame {
            return Err(Rejected::OutOfOrder);
        }
        let mut packet = Packet {
            first_frame,
            len: samples.len(),
            samples: [0.0; MAX_SAMPLES],
        };
        for (to, from) in packet.samples.iter_mut().zip(samples) {
            *to = from.clamp(-1.0, 1.0);
        }
        if self.control.is_cancelled() {
            return Err(Rejected::Cancelled);
        }
        // Full buffers consume their time too. Retrying one must not move the
        // clock backwards or overwrite speech already queued for the worker.
        self.next_frame = end;
        if self.producer.push(packet).is_err() {
            self.dropped_frames = self.dropped_frames.saturating_add(frames);
            self.dropped.store(self.dropped_frames, Ordering::Release);
            return Err(Rejected::Full);
        }
        Ok(())
    }
}

/// Single worker consumer; cancellation discards queued audio. A cancellation
/// racing push may leave a packet in the ring, but it cannot pass this check.
/// Dropping both endpoints releases ring memory; this is not secure erasure.
pub struct Reader {
    consumer: Consumer<Packet>,
    control: Control,
    format: Format,
    next_frame: u64,
    dropped: Arc<AtomicU64>,
}

impl Reader {
    pub(super) fn format(&self) -> Format {
        self.format
    }

    pub(super) fn control(&self) -> Control {
        self.control.clone()
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Acquire)
    }

    pub fn try_next(&mut self) -> Result<Option<Block>, Rejected> {
        if self.control.is_cancelled() {
            // The ring is bounded; a racing producer can add at most one last
            // packet. Repeated calls still refuse it, never deliver it.
            for _ in 0..MAX_BLOCKS {
                if self.consumer.pop().is_err() {
                    break;
                }
            }
            return Err(Rejected::Cancelled);
        }
        if !self.control.0.capturing.load(Ordering::Acquire) {
            return Err(Rejected::NotReady);
        }
        let packet = match self.consumer.pop() {
            Ok(packet) => packet,
            // A producer can publish its final packet between the empty read
            // and its drop. Recheck after observing closure before reporting it.
            Err(_) if self.consumer.is_abandoned() => {
                self.consumer.pop().map_err(|_| Rejected::Closed)?
            }
            Err(_) => return Ok(None),
        };
        if self.control.is_cancelled() {
            return Err(Rejected::Cancelled);
        }
        let gap_frames = packet.first_frame - self.next_frame;
        self.next_frame = packet.first_frame + (packet.len / self.format.channels as usize) as u64;
        Ok(Some(Block {
            packet,
            control: self.control.clone(),
            format: self.format,
            gap_frames,
        }))
    }
}

/// Worker-owned samples retain their operation and source. Any later consumer
/// must recheck belongs_to/current cancellation before committing a result;
/// cancellation cannot retract samples already returned to a worker.
pub struct Block {
    packet: Packet,
    control: Control,
    format: Format,
    gap_frames: u64,
}

impl Block {
    pub fn application(&self) -> &Application {
        &self.control.0.application
    }

    pub fn belongs_to(&self, current: &Control) -> bool {
        Arc::ptr_eq(&self.control.0, &current.0) && !self.control.is_cancelled()
    }

    pub fn format(&self) -> Format {
        self.format
    }

    pub fn first_frame(&self) -> u64 {
        self.packet.first_frame
    }

    /// Missing range is [first_frame - gap_frames, first_frame). Silence is
    /// represented by real zero samples; a gap never fabricates such samples.
    pub fn gap_frames(&self) -> u64 {
        self.gap_frames
    }

    pub fn samples(&self) -> &[f32] {
        &self.packet.samples[..self.packet.len]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_audio::{Capture, Gate};

    fn approved(id: &str) -> (Gate, Control, Start) {
        let gate = Gate::default();
        let mut review = gate
            .review(Application::new(id.into(), "Fictional player".into()).unwrap())
            .unwrap();
        let control = review.control();
        let start = gate.approve(&mut review).unwrap();
        (gate, control, start)
    }

    fn running(channels: u16, blocks: usize) -> (Gate, Control, Capture<()>, Input, Reader) {
        let (gate, control, mut start) = approved("fictional-player");
        let (input, reader) = start
            .handoff(Format::new(48_000, channels).unwrap(), blocks)
            .unwrap();
        let capture = start.run(|_, _| Ok(())).unwrap();
        (gate, control, capture, input, reader)
    }

    #[test]
    fn approval_bounds_format_capacity_and_one_queue_before_delivery() {
        for (rate, channels) in [(0, 1), (7_999, 1), (192_001, 1), (48_000, 0), (48_000, 9)] {
            assert_eq!(Format::new(rate, channels), Err(Rejected::InvalidFormat));
        }
        let (_gate, control, mut start) = approved("fictional-player");
        let format = Format::new(48_000, 2).unwrap();
        for capacity in [0, MAX_BLOCKS + 1, usize::MAX] {
            assert!(matches!(
                start.handoff(format, capacity),
                Err(Rejected::InvalidCapacity)
            ));
        }
        let (mut input, mut reader) = start.handoff(format, 2).unwrap();
        assert!(matches!(
            start.handoff(format, 1),
            Err(Rejected::AlreadyCreated)
        ));
        input.push(&control, 0, &[0.2, -0.2]).unwrap();
        assert!(matches!(reader.try_next(), Err(Rejected::NotReady)));
        let _capture = start.run(|_, _| Ok(())).unwrap();
        let block = reader.try_next().unwrap().unwrap();
        assert_eq!(block.application().selection_id(), "fictional-player");
        assert_eq!(block.application().name(), "Fictional player");
        assert_eq!(block.format().sample_rate(), 48_000);
        assert_eq!(block.format().channels(), 2);
        assert_eq!(block.samples(), &[0.2, -0.2]);
        assert!(block.belongs_to(&control));
    }

    #[test]
    fn full_queue_keeps_old_audio_and_reports_exact_gap_without_silence() {
        let (_gate, control, _capture, mut input, mut reader) = running(2, 1);
        input.push(&control, 0, &[0.1, 0.2, 0.3, 0.4]).unwrap();
        assert_eq!(input.push(&control, 2, &[0.5; 6]), Err(Rejected::Full));
        assert_eq!(input.push(&control, 5, &[0.5; 2]), Err(Rejected::Full));
        assert_eq!(reader.dropped_frames(), 4);
        let first = reader.try_next().unwrap().unwrap();
        assert_eq!(first.first_frame(), 0);
        assert_eq!(first.gap_frames(), 0);
        assert_eq!(first.samples(), &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(
            input.push(&control, 2, &[0.5; 6]),
            Err(Rejected::OutOfOrder)
        );
        input.push(&control, 6, &[0.0, 0.0]).unwrap();
        let next = reader.try_next().unwrap().unwrap();
        assert_eq!(next.first_frame(), 6);
        assert_eq!(next.gap_frames(), 4); // Frames [2, 6) were lost.
        assert_eq!(next.samples(), &[0.0, 0.0]); // Only the actual silent frame.
        assert!(reader.try_next().unwrap().is_none());
    }

    #[test]
    fn source_clock_gaps_remain_distinct_from_queue_drops_and_channel_samples() {
        let (_gate, control, _capture, mut input, mut reader) = running(2, 2);
        input.push(&control, 10, &[2.0, -2.0, 0.5, -0.5]).unwrap();
        input.push(&control, 20, &[0.7, 0.8]).unwrap();
        let first = reader.try_next().unwrap().unwrap();
        assert_eq!((first.first_frame(), first.gap_frames()), (10, 10));
        assert_eq!(first.samples(), &[1.0, -1.0, 0.5, -0.5]);
        let second = reader.try_next().unwrap().unwrap();
        assert_eq!((second.first_frame(), second.gap_frames()), (20, 8));
        assert_eq!(reader.dropped_frames(), 0);
    }

    #[test]
    fn foreign_and_malformed_buffers_do_not_poison_the_selected_timeline() {
        let (_gate, control, _capture, mut input, mut reader) = running(2, 2);
        let (_other, foreign, _start) = approved("fictional-player");
        assert_eq!(
            input.push(&foreign, 100, &[0.4, 0.5]),
            Err(Rejected::ForeignSource)
        );
        for samples in [
            &[][..],
            &[0.1][..],
            &[f32::NAN, 0.1][..],
            &[f32::INFINITY, 0.1][..],
            &[0.0; MAX_SAMPLES + 2][..],
        ] {
            assert_eq!(
                input.push(&control, 100, samples),
                Err(Rejected::InvalidBuffer)
            );
        }
        assert_eq!(
            input.push(&control, u64::MAX, &[0.1, 0.2]),
            Err(Rejected::InvalidBuffer)
        );
        input.push(&control, 0, &[0.1, 0.2]).unwrap();
        assert_eq!(
            input.push(&control, 0, &[0.3, 0.4]),
            Err(Rejected::OutOfOrder)
        );
        input.push(&control, 1, &[0.3, 0.4]).unwrap();
        assert_eq!(reader.try_next().unwrap().unwrap().first_frame(), 0);
        assert_eq!(reader.try_next().unwrap().unwrap().first_frame(), 1);
        assert_eq!(reader.dropped_frames(), 0);
    }

    #[test]
    fn stop_discards_queued_audio_and_invalidates_already_returned_blocks() {
        let (gate, control, capture, mut input, mut reader) = running(1, 2);
        input.push(&control, 0, &[0.2]).unwrap();
        input.push(&control, 1, &[0.3]).unwrap();
        let returned = reader.try_next().unwrap().unwrap();
        assert!(returned.belongs_to(&control));
        gate.stop(&control).unwrap();
        assert!(!returned.belongs_to(&control));
        assert_eq!(input.push(&control, 2, &[0.4]), Err(Rejected::Cancelled));
        assert!(matches!(reader.try_next(), Err(Rejected::Cancelled)));
        drop(capture);
        let mut review = gate
            .review(Application::new("fictional-player".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let replacement = review.control();
        let mut start = gate.approve(&mut review).unwrap();
        let (mut new_input, mut new_reader) =
            start.handoff(Format::new(48_000, 1).unwrap(), 1).unwrap();
        let _capture = start.run(|_, _| Ok(())).unwrap();
        assert_eq!(
            new_input.push(&control, 0, &[0.5]),
            Err(Rejected::ForeignSource)
        );
        assert!(!returned.belongs_to(&replacement));
        assert!(matches!(reader.try_next(), Err(Rejected::Cancelled)));
        new_input.push(&replacement, 0, &[0.6]).unwrap();
        assert_eq!(new_reader.try_next().unwrap().unwrap().samples(), &[0.6]);
    }

    #[test]
    fn abandoned_or_failed_start_cannot_deliver_startup_audio() {
        for fail in [false, true] {
            let (_gate, control, mut start) = approved("fictional-player");
            let (mut input, mut reader) =
                start.handoff(Format::new(48_000, 1).unwrap(), 1).unwrap();
            input.push(&control, 0, &[0.2]).unwrap();
            if fail {
                assert!(start
                    .run::<()>(|_, _| Err(super::super::Failure::PermissionDenied))
                    .is_err());
            } else {
                drop(start);
            }
            assert!(matches!(reader.try_next(), Err(Rejected::Cancelled)));
        }
        let (gate, control, mut start) = approved("fictional-player");
        gate.stop(&control).unwrap();
        assert!(matches!(
            start.handoff(Format::new(48_000, 1).unwrap(), 1),
            Err(Rejected::Cancelled)
        ));
    }

    #[test]
    fn endpoints_close_without_retrying_or_losing_already_queued_frames() {
        let (_gate, control, _capture, mut input, mut reader) = running(1, 1);
        input.push(&control, 0, &[0.2]).unwrap();
        drop(input);
        assert_eq!(reader.try_next().unwrap().unwrap().samples(), &[0.2]);
        assert!(matches!(reader.try_next(), Err(Rejected::Closed)));
        let (_gate, control, _capture, mut input, reader) = running(1, 1);
        drop(reader);
        assert_eq!(input.push(&control, 0, &[0.2]), Err(Rejected::Closed));
    }

    #[test]
    fn slow_worker_on_another_thread_preserves_absolute_positions_over_repeated_overruns() {
        use std::{sync::mpsc, thread, time::Duration};
        let (_gate, control, _capture, mut input, mut reader) = running(1, 2);
        let (queued, ready) = mpsc::sync_channel(0);
        let (drained, resume) = mpsc::sync_channel(0);
        let worker = thread::spawn(move || {
            for cycle in 0..100u64 {
                ready.recv_timeout(Duration::from_secs(3)).unwrap();
                for n in 0..2u64 {
                    let block = reader.try_next().unwrap().unwrap();
                    assert_eq!(block.first_frame(), cycle * 4 + n);
                    assert_eq!(block.gap_frames(), if cycle > 0 && n == 0 { 2 } else { 0 });
                    assert_eq!(block.samples(), &[0.25]);
                }
                drained.send(()).unwrap();
            }
            reader.dropped_frames()
        });
        for cycle in 0..100u64 {
            for n in 0..4u64 {
                assert_eq!(
                    input.push(&control, cycle * 4 + n, &[0.25]),
                    if n < 2 { Ok(()) } else { Err(Rejected::Full) }
                );
            }
            queued.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        assert_eq!(worker.join().unwrap(), 200);
    }
}
