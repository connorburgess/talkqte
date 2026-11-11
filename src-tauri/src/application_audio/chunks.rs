//! Offline, worker-side preparation for the transcription input contract.
//! No recognizer, native source or runtime command is connected here.

use super::{
    handoff::{Rejected, MAX_SAMPLES},
    timing::{frame_ms, SessionReader, TimedBlock, TimingError},
    Control,
};
use crate::transcription::{AudioChunk, SAMPLE_RATE};
use std::sync::Arc;

pub const CHUNK_SAMPLES: usize = 3 * SAMPLE_RATE;
// One input block can either finish a full chunk or end a partial at a gap,
// never both. This keeps each poll's output bounded to one chunk.
const _: () = assert!(MAX_SAMPLES < CHUNK_SAMPLES);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChunkError {
    UnsupportedFormat,
    Timing(TimingError),
}

/// A bounded mono chunk with the operation/session that supplied its samples.
/// Recheck belongs_to before committing results: returned work cannot be
/// retracted by Stop. Borrowing audio does not transfer source authorization.
pub struct Chunk {
    audio: AudioChunk,
    control: Control,
    session: u64,
}

impl Chunk {
    pub fn audio(&self) -> &AudioChunk {
        &self.audio
    }

    pub fn belongs_to(&self, current_session: u64, current_source: &Control) -> bool {
        self.session == current_session
            && Arc::ptr_eq(&self.control.0, &current_source.0)
            && !self.control.is_cancelled()
    }
}

/// Owns one source/session reader and at most three seconds of pending audio.
/// Each poll consumes at most one handoff block and returns at most one chunk.
/// A gap or clean EOF can produce a shorter chunk, including sub-ms audio.
/// Allocations and copies belong on the worker, never in a native callback.
pub struct Chunker {
    reader: Option<SessionReader>,
    control: Control,
    session: u64,
    origin_ms: u64,
    pending: Vec<f32>,
    pending_start_ms: u64,
    terminal: Option<ChunkError>,
    final_dropped_frames: u64,
}

impl Chunker {
    pub(super) fn new(
        reader: SessionReader,
        control: Control,
        session: u64,
        origin_ms: u64,
    ) -> Self {
        Self {
            reader: Some(reader),
            control,
            session,
            origin_ms,
            pending: Vec::with_capacity(CHUNK_SAMPLES),
            pending_start_ms: 0,
            terminal: None,
            final_dropped_frames: 0,
        }
    }

    pub fn dropped_frames(&self) -> u64 {
        self.reader
            .as_ref()
            .map_or(self.final_dropped_frames, SessionReader::dropped_frames)
    }

    /// None means more audio is needed. Closed is terminal, following the
    /// final partial chunk (if any). Cancel/session replacement never flushes.
    pub fn try_next(&mut self, current_session: u64) -> Result<Option<Chunk>, ChunkError> {
        if let Some(error) = self.terminal {
            return Err(error);
        }
        if current_session != self.session {
            return Err(self.retire(TimingError::SessionChanged));
        }
        if self.control.is_cancelled() {
            return Err(self.retire(TimingError::Handoff(Rejected::Cancelled)));
        }
        let next = self
            .reader
            .as_mut()
            .expect("active reader")
            .try_next(current_session);
        let result = match next {
            Ok(Some(block)) => self.append(block),
            Ok(None) => return Ok(None),
            Err(TimingError::Handoff(Rejected::NotReady)) => {
                return Err(ChunkError::Timing(TimingError::Handoff(Rejected::NotReady)));
            }
            Err(TimingError::Handoff(Rejected::Closed)) => {
                // Closure means the producer ended, not that Stop permits a
                // final flush. Cancellation can race the empty read.
                if self.control.is_cancelled() {
                    return Err(self.retire(TimingError::Handoff(Rejected::Cancelled)));
                }
                let last = self.take_pending();
                let closed = self.retire(TimingError::Handoff(Rejected::Closed));
                return last.map(Some).ok_or(closed);
            }
            Err(error) => return Err(self.retire(error)),
        };
        if self.control.is_cancelled() {
            return Err(self.retire(TimingError::Handoff(Rejected::Cancelled)));
        }
        match result {
            Ok(chunk) => Ok(chunk),
            Err(error) => Err(self.retire(error)),
        }
    }

    fn append(&mut self, block: TimedBlock) -> Result<Option<Chunk>, TimingError> {
        // Gap presence comes from exact frames, never rounded milliseconds.
        let mut ready = if block.gap().is_some() {
            self.take_pending()
        } else {
            None
        };
        if self.pending.is_empty() {
            self.pending_start_ms = block.start_ms();
        }
        let samples = block.audio().samples();
        let take = samples.len().min(CHUNK_SAMPLES - self.pending.len());
        self.pending.extend_from_slice(&samples[..take]);
        if self.pending.len() == CHUNK_SAMPLES {
            ready = self.take_pending();
        }
        if take < samples.len() {
            let first = block
                .audio()
                .first_frame()
                .checked_add(take as u64)
                .ok_or(TimingError::Overflow)?;
            // Use frame zero, not the floored time of the split block.
            self.pending_start_ms = frame_ms(self.origin_ms, first, SAMPLE_RATE as u32)?;
            self.pending.extend_from_slice(&samples[take..]);
        }
        Ok(ready)
    }

    fn take_pending(&mut self) -> Option<Chunk> {
        if self.pending.is_empty() {
            return None;
        }
        Some(Chunk {
            audio: AudioChunk {
                start_ms: self.pending_start_ms,
                samples: std::mem::replace(&mut self.pending, Vec::with_capacity(CHUNK_SAMPLES)),
            },
            control: self.control.clone(),
            session: self.session,
        })
    }

    fn retire(&mut self, error: TimingError) -> ChunkError {
        if let Some(reader) = self.reader.take() {
            self.final_dropped_frames = reader.dropped_frames();
        }
        self.pending = Vec::new();
        let error = ChunkError::Timing(error);
        self.terminal = Some(error);
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_audio::{
        handoff::{Format, Input, Reader},
        Application, Capture, Gate, Start,
    };

    fn approved(
        rate: u32,
        channels: u16,
        capacity: usize,
    ) -> (Gate, Control, Start, Input, Reader) {
        let gate = Gate::default();
        let mut review = gate
            .review(Application::new("fictional-player".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let control = review.control();
        let mut start = gate.approve(&mut review).unwrap();
        let (input, reader) = start
            .handoff(Format::new(rate, channels).unwrap(), capacity)
            .unwrap();
        (gate, control, start, input, reader)
    }

    fn running(capacity: usize, origin: u64) -> (Gate, Control, Capture<()>, Input, Chunker) {
        let (gate, control, start, input, reader) = approved(16_000, 1, capacity);
        let capture = start.run(|_, _| Ok(())).unwrap();
        let chunks = reader.bind_session(7, origin).into_chunks().unwrap();
        (gate, control, capture, input, chunks)
    }

    fn timing(error: TimingError) -> ChunkError {
        ChunkError::Timing(error)
    }
    fn handoff(error: Rejected) -> ChunkError {
        timing(TimingError::Handoff(error))
    }

    #[test]
    fn continuous_irregular_blocks_split_at_three_seconds_without_sample_loss_or_clock_drift() {
        let (_gate, control, _capture, mut input, mut chunks) = running(1, 123);
        let total = 20 * CHUNK_SAMPLES + 37;
        let initial_frame = 16_000 * 60 * 60 * 24 + 13;
        let mut emitted = 0;
        let mut submitted = 0;
        while submitted < total {
            let len = (1 + submitted % MAX_SAMPLES).min(total - submitted);
            let samples: Vec<_> = (submitted..submitted + len)
                .map(|n| (n % 17) as f32 / 17.0)
                .collect();
            input
                .push(&control, initial_frame + submitted as u64, &samples)
                .unwrap();
            submitted += len;
            if let Some(chunk) = chunks.try_next(7).unwrap() {
                assert_eq!(chunk.audio().samples.len(), CHUNK_SAMPLES);
                assert_eq!(
                    chunk.audio().start_ms,
                    123 + (initial_frame + emitted as u64) / 16
                );
                assert!(chunk.belongs_to(7, &control));
                for (offset, sample) in chunk.audio().samples.iter().enumerate() {
                    assert_eq!(*sample, ((emitted + offset) % 17) as f32 / 17.0);
                }
                emitted += CHUNK_SAMPLES;
            }
            assert!(chunks.pending.len() < CHUNK_SAMPLES);
            assert_eq!(chunks.pending.capacity(), CHUNK_SAMPLES);
        }
        drop(input);
        let last = chunks.try_next(7).unwrap().unwrap();
        assert_eq!(last.audio().samples.len(), 37);
        assert_eq!(
            last.audio().start_ms,
            123 + (initial_frame + emitted as u64) / 16
        );
        for (offset, sample) in last.audio().samples.iter().enumerate() {
            assert_eq!(*sample, ((emitted + offset) % 17) as f32 / 17.0);
        }
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Closed)));
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Closed)));
    }

    #[test]
    fn even_a_submillisecond_gap_cuts_audio_instead_of_inventing_silence() {
        let (_gate, control, _capture, mut input, mut chunks) = running(1, 500);
        input.push(&control, 100, &[0.1; 3]).unwrap();
        assert!(chunks.try_next(7).unwrap().is_none());
        input.push(&control, 104, &[0.2; 2]).unwrap();
        let before = chunks.try_next(7).unwrap().unwrap();
        assert_eq!(before.audio().samples, [0.1; 3]);
        assert_eq!(before.audio().start_ms, 506);
        drop(input);
        let after = chunks.try_next(7).unwrap().unwrap();
        assert_eq!(after.audio().samples, [0.2; 2]);
        assert_eq!(after.audio().start_ms, 506);
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Closed)));
    }

    #[test]
    fn capacity_loss_cuts_partial_audio_and_trailing_drops_remain_counted() {
        let (_gate, control, _capture, mut input, mut chunks) = running(1, 0);
        input.push(&control, 0, &[0.1; 160]).unwrap();
        assert_eq!(input.push(&control, 160, &[0.9; 160]), Err(Rejected::Full));
        assert!(chunks.try_next(7).unwrap().is_none());
        input.push(&control, 320, &[0.2; 160]).unwrap();
        assert_eq!(input.push(&control, 480, &[0.9; 160]), Err(Rejected::Full));
        let before = chunks.try_next(7).unwrap().unwrap();
        assert_eq!(before.audio().samples, [0.1; 160]);
        drop(input);
        let after = chunks.try_next(7).unwrap().unwrap();
        assert_eq!(after.audio().samples, [0.2; 160]);
        assert_eq!(after.audio().start_ms, 20);
        assert_eq!(chunks.dropped_frames(), 320);
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Closed)));
        assert_eq!(chunks.dropped_frames(), 320);
    }

    #[test]
    fn stop_discards_pending_and_queued_audio_even_after_producer_closes() {
        let (gate, control, _capture, mut input, mut chunks) = running(1, 0);
        input.push(&control, 0, &[0.1; 160]).unwrap();
        assert!(chunks.try_next(7).unwrap().is_none());
        input.push(&control, 160, &[0.2; 160]).unwrap();
        drop(input);
        gate.stop(&control).unwrap();
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Cancelled)));
        assert!(chunks.pending.is_empty());
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Cancelled)));
    }

    #[test]
    fn session_replacement_discards_pending_and_permanently_closes_reader() {
        let (_gate, control, _capture, mut input, mut chunks) = running(1, 0);
        input.push(&control, 0, &[0.1; 160]).unwrap();
        assert!(chunks.try_next(7).unwrap().is_none());
        assert_eq!(
            chunks.try_next(8).err(),
            Some(timing(TimingError::SessionChanged))
        );
        assert_eq!(
            chunks.try_next(7).err(),
            Some(timing(TimingError::SessionChanged))
        );
        assert!(chunks.pending.is_empty());
        assert_eq!(input.push(&control, 160, &[0.0]), Err(Rejected::Closed));
    }

    #[test]
    fn returned_chunks_retain_exact_source_and_session_guards_after_eof() {
        let (gate, control, capture, mut input, mut chunks) = running(1, 0);
        input.push(&control, 0, &[0.1; 160]).unwrap();
        chunks.try_next(7).unwrap();
        drop(input);
        let chunk = chunks.try_next(7).unwrap().unwrap();
        assert!(chunk.belongs_to(7, &control));
        assert!(!chunk.belongs_to(8, &control));
        let (_other_gate, foreign, _other_capture, _other_input, _other_chunks) = running(1, 0);
        assert!(!chunk.belongs_to(7, &foreign));
        gate.stop(&control).unwrap();
        assert!(!chunk.belongs_to(7, &control));
        drop(capture);
        let review = gate
            .review(Application::new("fictional-player".into(), "Fictional player".into()).unwrap())
            .unwrap();
        assert!(!chunk.belongs_to(7, &review.control()));
    }

    #[test]
    fn unsupported_formats_are_refused_without_relabelling_or_consuming_audio() {
        for (rate, channels) in [
            (8_000, 1),
            (44_100, 1),
            (48_000, 2),
            (16_000, 2),
            (192_000, 8),
        ] {
            let (_gate, control, _start, mut input, reader) = approved(rate, channels, 1);
            let samples = vec![0.1; channels as usize];
            input.push(&control, 0, &samples).unwrap();
            assert_eq!(
                reader.bind_session(7, 0).into_chunks().err(),
                Some(ChunkError::UnsupportedFormat)
            );
            assert_eq!(input.push(&control, 1, &samples), Err(Rejected::Closed));
        }
    }

    #[test]
    fn startup_waits_then_empty_eof_and_retired_reader_never_emit_empty_chunks() {
        let (_gate, control, start, mut input, reader) = approved(16_000, 1, 1);
        let mut chunks = reader.bind_session(7, 0).into_chunks().unwrap();
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::NotReady)));
        let _capture = start.run(|_, _| Ok(())).unwrap();
        assert!(chunks.try_next(7).unwrap().is_none());
        input.push(&control, 0, &[0.1]).unwrap();
        assert!(chunks.try_next(7).unwrap().is_none());
        drop(input);
        assert_eq!(chunks.try_next(7).unwrap().unwrap().audio().samples, [0.1]);
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Closed)));

        let (_gate, _control, _capture, input, mut chunks) = running(1, 0);
        drop(input);
        assert_eq!(chunks.try_next(7).err(), Some(handoff(Rejected::Closed)));
        let (_gate, _control, _start, _input, reader) = approved(16_000, 1, 1);
        let mut reader = reader.bind_session(7, 0);
        assert_eq!(reader.try_next(8).err(), Some(TimingError::SessionChanged));
        assert_eq!(
            reader.into_chunks().err(),
            Some(timing(TimingError::SessionChanged))
        );
    }

    #[test]
    fn overflow_discards_an_earlier_partial_instead_of_flushing_it_as_success() {
        let (_gate, control, _capture, mut input, mut chunks) = running(1, u64::MAX - 1);
        input.push(&control, 0, &[0.1; 16]).unwrap();
        assert!(chunks.try_next(7).unwrap().is_none());
        input.push(&control, 16, &[0.2; 16]).unwrap();
        assert_eq!(
            chunks.try_next(7).err(),
            Some(timing(TimingError::Overflow))
        );
        assert!(chunks.pending.is_empty());
        assert_eq!(input.push(&control, 32, &[0.0]), Err(Rejected::Closed));
    }
}
