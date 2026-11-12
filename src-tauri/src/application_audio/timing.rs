//! Worker-side session timing for synthetic application audio. The caller must
//! supply the session time of frame zero; queue arrival time is never a clock.
//! Native timestamp conversion, drift correction and resampling are not supplied.

use super::{
    handoff::{Block, Reader, Rejected},
    Control,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimingError {
    Handoff(Rejected),
    SessionChanged,
    Overflow,
    Clock,
}

/// A missing frame range. Millisecond endpoints are floored independently, so
/// a real gap shorter than one millisecond may have equal endpoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gap {
    pub frames: u64,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// One immutable mapping for one reader and session. Changing the session
/// retires the reader permanently; the capture owner must also stop its source.
pub struct SessionReader {
    reader: Option<Reader>,
    session: u64,
    origin_ms: u64,
    terminal: Option<TimingError>,
    final_dropped_frames: u64,
}

impl Reader {
    /// Consume the reader so it cannot be rebound to another clock. origin_ms
    /// is the time of frame zero in this session, not the first delivered frame.
    pub fn bind_session(self, session: u64, origin_ms: u64) -> SessionReader {
        SessionReader {
            reader: Some(self),
            session,
            origin_ms,
            terminal: None,
            final_dropped_frames: 0,
        }
    }
}

impl SessionReader {
    /// Prepare bounded 16 kHz mono chunks on a worker. Other formats require
    /// explicit conversion; this consumes the reader even when refused.
    pub fn into_chunks(self) -> Result<super::chunks::Chunker, super::chunks::ChunkError> {
        use super::chunks::{ChunkError, Chunker};
        if let Some(error) = self.terminal {
            return Err(ChunkError::Timing(error));
        }
        let reader = self.reader.as_ref().expect("active reader");
        if reader.format().sample_rate() != crate::transcription::SAMPLE_RATE as u32
            || reader.format().channels() != 1
        {
            return Err(ChunkError::UnsupportedFormat);
        }
        let control = reader.control();
        let (session, origin_ms) = (self.session, self.origin_ms);
        Ok(Chunker::new(self, control, session, origin_ms))
    }

    /// Queue-capacity loss, including trailing drops without a later block.
    /// After retirement this is the last observed count, not a native loss total.
    pub fn dropped_frames(&self) -> u64 {
        self.reader
            .as_ref()
            .map_or(self.final_dropped_frames, Reader::dropped_frames)
    }

    pub fn try_next(&mut self, current_session: u64) -> Result<Option<TimedBlock>, TimingError> {
        if let Some(error) = self.terminal {
            return Err(error);
        }
        if current_session != self.session {
            return self.retire(TimingError::SessionChanged);
        }
        let block = match self.reader.as_mut().expect("active reader").try_next() {
            Ok(Some(block)) => block,
            Ok(None) => return Ok(None),
            Err(Rejected::NotReady) => return Err(TimingError::Handoff(Rejected::NotReady)),
            Err(error) => return self.retire(TimingError::Handoff(error)),
        };
        match TimedBlock::map(block, self.session, self.origin_ms) {
            Ok(block) => Ok(Some(block)),
            Err(error) => self.retire(error),
        }
    }

    fn retire(&mut self, error: TimingError) -> Result<Option<TimedBlock>, TimingError> {
        if let Some(reader) = self.reader.take() {
            self.final_dropped_frames = reader.dropped_frames();
        }
        self.terminal = Some(error);
        Err(error)
    }
}

/// Original source samples and frame positions with session-relative times.
/// These are not 16 kHz mono transcription chunks. Cancellation/session changes
/// cannot retract returned work: recheck belongs_to before committing a result.
pub struct TimedBlock {
    audio: Block,
    session: u64,
    start_ms: u64,
    end_ms: u64,
    gap: Option<Gap>,
}

impl TimedBlock {
    fn map(audio: Block, session: u64, origin_ms: u64) -> Result<Self, TimingError> {
        let rate = audio.format().sample_rate();
        Self::map_with(audio, session, |frame| frame_ms(origin_ms, frame, rate))
    }

    pub(super) fn map_with(
        audio: Block,
        session: u64,
        mut time: impl FnMut(u64) -> Result<u64, TimingError>,
    ) -> Result<Self, TimingError> {
        let first = audio.first_frame();
        let frames = (audio.samples().len() / audio.format().channels() as usize) as u64;
        let end = first.checked_add(frames).ok_or(TimingError::Overflow)?;
        let start_ms = time(first)?;
        let end_ms = time(end)?;
        let gap = if audio.gap_frames() == 0 {
            None
        } else {
            Some(Gap {
                frames: audio.gap_frames(),
                start_ms: time(
                    first
                        .checked_sub(audio.gap_frames())
                        .ok_or(TimingError::Overflow)?,
                )?,
                end_ms: start_ms,
            })
        };
        if end_ms < start_ms || gap.is_some_and(|gap| gap.start_ms > gap.end_ms) {
            return Err(TimingError::Clock);
        }
        Ok(Self {
            audio,
            session,
            start_ms,
            end_ms,
            gap,
        })
    }

    pub fn belongs_to(&self, current_session: u64, current_source: &Control) -> bool {
        self.session == current_session && self.audio.belongs_to(current_source)
    }

    pub fn audio(&self) -> &Block {
        &self.audio
    }

    /// Inclusive start, floored from the absolute frame position.
    pub fn start_ms(&self) -> u64 {
        self.start_ms
    }

    /// Exclusive end, floored independently. Can equal start_ms for short
    /// blocks; the original frame positions and samples retain full precision.
    pub fn end_ms(&self) -> u64 {
        self.end_ms
    }

    pub fn gap(&self) -> Option<Gap> {
        self.gap
    }
}

pub(super) fn frame_ms(origin_ms: u64, frame: u64, sample_rate: u32) -> Result<u64, TimingError> {
    let offset = u128::from(frame)
        .checked_mul(1_000)
        .ok_or(TimingError::Overflow)?
        / u128::from(sample_rate);
    origin_ms
        .checked_add(u64::try_from(offset).map_err(|_| TimingError::Overflow)?)
        .ok_or(TimingError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_audio::{
        handoff::{Format, Input},
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

    fn running(
        rate: u32,
        channels: u16,
        capacity: usize,
    ) -> (Gate, Control, Capture<()>, Input, Reader) {
        let (gate, control, start, input, reader) = approved(rate, channels, capacity);
        let capture = start.run(|_, _| Ok(())).unwrap();
        (gate, control, capture, input, reader)
    }

    #[test]
    fn delayed_stereo_blocks_keep_frame_zero_origin_and_source() {
        let (_gate, control, _capture, mut input, reader) = running(48_000, 2, 2);
        let mut reader = reader.bind_session(7, 5_000);
        // Both arrive before any consumption; stereo samples are not frames.
        input.push(&control, 48_000, &[0.25; 96]).unwrap();
        input.push(&control, 48_048, &[0.5; 96]).unwrap();
        let block = reader.try_next(7).unwrap().unwrap();
        assert_eq!((block.start_ms(), block.end_ms()), (6_000, 6_001));
        assert_eq!(
            block.gap(),
            Some(Gap {
                frames: 48_000,
                start_ms: 5_000,
                end_ms: 6_000
            })
        );
        assert_eq!(block.audio().samples(), &[0.25; 96]);
        assert_eq!(
            block.audio().application().selection_id(),
            "fictional-player"
        );
        assert!(block.belongs_to(7, &control));
        assert!(!block.belongs_to(8, &control));
        let next = reader.try_next(7).unwrap().unwrap();
        assert_eq!(
            (next.start_ms(), next.end_ms(), next.gap()),
            (6_001, 6_002, None)
        );
        assert!(reader.try_next(7).unwrap().is_none());
    }

    #[test]
    fn irregular_blocks_at_boundary_and_fractional_rates_do_not_accumulate_rounding() {
        for rate in [8_000, 44_100, 192_000] {
            let (_gate, control, _capture, mut input, reader) = running(rate, 1, 1);
            let mut reader = reader.bind_session(1, 123);
            // A long-running source and many irregular boundaries, including
            // sub-ms blocks. Compare against absolute rational time each time.
            let mut first = u64::from(rate) * 60 * 60 * 24 * 365;
            for i in 0..500 {
                let len = 1 + (i * 137 % 2_048);
                input.push(&control, first, &vec![0.0; len]).unwrap();
                let block = reader.try_next(1).unwrap().unwrap();
                let expected = |frame| 123 + (u128::from(frame) * 1_000 / u128::from(rate)) as u64;
                assert_eq!(block.start_ms(), expected(first));
                assert_eq!(block.end_ms(), expected(first + len as u64));
                assert_eq!(block.gap().is_some(), i == 0);
                first += len as u64;
            }
        }
    }

    #[test]
    fn queue_loss_and_submillisecond_source_gaps_remain_discontinuities() {
        let (_gate, control, _capture, mut input, reader) = running(48_000, 1, 1);
        let mut reader = reader.bind_session(1, 0);
        input.push(&control, 0, &[0.2; 48]).unwrap();
        assert_eq!(input.push(&control, 48, &[0.3; 48]), Err(Rejected::Full));
        reader.try_next(1).unwrap().unwrap();
        input.push(&control, 96, &[0.4]).unwrap();
        let block = reader.try_next(1).unwrap().unwrap();
        assert_eq!(
            block.gap(),
            Some(Gap {
                frames: 48,
                start_ms: 1,
                end_ms: 2
            })
        );
        assert_eq!(block.audio().samples(), &[0.4]);
        input.push(&control, 98, &[0.5]).unwrap();
        let block = reader.try_next(1).unwrap().unwrap();
        assert_eq!(
            block.gap(),
            Some(Gap {
                frames: 1,
                start_ms: 2,
                end_ms: 2
            })
        );
        assert_eq!((block.start_ms(), block.end_ms()), (2, 2));
        assert_eq!(block.audio().samples(), &[0.5]);
        input.push(&control, 99, &[0.0; 48]).unwrap();
        assert_eq!(input.push(&control, 147, &[0.0; 48]), Err(Rejected::Full));
        assert_eq!(reader.dropped_frames(), 96);
        drop(input);
        reader.try_next(1).unwrap().unwrap();
        assert_eq!(
            reader.try_next(1).err(),
            Some(TimingError::Handoff(Rejected::Closed))
        );
        assert_eq!(reader.dropped_frames(), 96);
    }

    #[test]
    fn session_replacement_permanently_retires_reader_and_rejects_returned_work() {
        let (_gate, control, _capture, mut input, reader) = running(48_000, 1, 2);
        let mut reader = reader.bind_session(1, 0);
        input.push(&control, 0, &[0.0; 48]).unwrap();
        let block = reader.try_next(1).unwrap().unwrap();
        input.push(&control, 48, &[0.0; 48]).unwrap();
        assert_eq!(reader.try_next(2).err(), Some(TimingError::SessionChanged));
        assert_eq!(reader.try_next(1).err(), Some(TimingError::SessionChanged));
        assert_eq!(input.push(&control, 96, &[0.0]), Err(Rejected::Closed));
        assert!(!block.belongs_to(2, &control));
    }

    #[test]
    fn cancellation_and_same_application_restart_cannot_accept_old_work() {
        let (gate, control, capture, mut input, reader) = running(48_000, 1, 2);
        let mut reader = reader.bind_session(1, 0);
        input.push(&control, 0, &[0.0; 48]).unwrap();
        let block = reader.try_next(1).unwrap().unwrap();
        input.push(&control, 48, &[0.0; 48]).unwrap();
        gate.stop(&control).unwrap();
        assert_eq!(
            reader.try_next(1).err(),
            Some(TimingError::Handoff(Rejected::Cancelled))
        );
        assert!(!block.belongs_to(1, &control));
        drop(capture);
        let mut review = gate
            .review(Application::new("fictional-player".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let next_control = review.control();
        let next_start = gate.approve(&mut review).unwrap();
        let _next_capture = next_start.run(|_, _| Ok(())).unwrap();
        assert!(!block.belongs_to(1, &next_control));
        assert_eq!(
            reader.try_next(1).err(),
            Some(TimingError::Handoff(Rejected::Cancelled))
        );
    }

    #[test]
    fn startup_is_retryable_but_cancelled_start_and_closed_input_are_terminal() {
        let (gate, control, start, mut input, reader) = approved(48_000, 1, 1);
        let mut reader = reader.bind_session(1, 0);
        input.push(&control, 0, &[0.0; 48]).unwrap();
        assert_eq!(
            reader.try_next(1).err(),
            Some(TimingError::Handoff(Rejected::NotReady))
        );
        let _capture = start.run(|_, _| Ok(())).unwrap();
        drop(input);
        assert_eq!(reader.try_next(1).unwrap().unwrap().end_ms(), 1);
        assert_eq!(
            reader.try_next(1).err(),
            Some(TimingError::Handoff(Rejected::Closed))
        );
        drop(gate);
        let (gate, control, _start, _input, reader) = approved(48_000, 1, 1);
        let mut reader = reader.bind_session(1, 0);
        gate.stop(&control).unwrap();
        assert_eq!(
            reader.try_next(1).err(),
            Some(TimingError::Handoff(Rejected::Cancelled))
        );
    }

    #[test]
    fn end_overflow_retires_mapping_without_delivering_partially_valid_block() {
        let (_gate, control, _capture, mut input, reader) = running(8_000, 1, 1);
        let mut reader = reader.bind_session(1, u64::MAX - 1);
        input.push(&control, 0, &[0.0; 8]).unwrap();
        let block = reader.try_next(1).unwrap().unwrap();
        assert_eq!((block.start_ms(), block.end_ms()), (u64::MAX - 1, u64::MAX));
        input.push(&control, 8, &[0.0; 8]).unwrap();
        assert_eq!(reader.try_next(1).err(), Some(TimingError::Overflow));
        assert_eq!(reader.try_next(1).err(), Some(TimingError::Overflow));
        assert_eq!(input.push(&control, 16, &[0.0]), Err(Rejected::Closed));
    }

    #[test]
    fn large_frame_positions_use_wide_arithmetic_and_reject_origin_overflow() {
        for origin in [0, u64::MAX] {
            let (_gate, control, _capture, mut input, reader) = running(8_000, 1, 1);
            let mut reader = reader.bind_session(1, origin);
            input.push(&control, u64::MAX - 8, &[0.0; 8]).unwrap();
            let result = reader.try_next(1);
            if origin == 0 {
                let block = result.unwrap().unwrap();
                assert_eq!(block.end_ms(), u64::MAX / 8);
                assert_eq!(block.gap().unwrap().frames, u64::MAX - 8);
            } else {
                assert_eq!(result.err(), Some(TimingError::Overflow));
            }
        }
    }
}
