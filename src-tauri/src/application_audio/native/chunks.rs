//! Worker-side transcription chunks for native blocks. Each chunk keeps the
//! exact rational mapping of every block it holds, so a recognizer offset
//! inside the chunk maps to corrected session time. A floored chunk start plus
//! a nominal 16 kHz offset would lose that correction. A transcription worker
//! can queue these chunks, but no capture path creates one in the app.

use super::{clock::NativeBlock, position::Position};
use crate::application_audio::{
    chunks::ChunkError,
    handoff::{Rejected, MAX_SAMPLES},
    timing::TimingError,
    Control,
};
use crate::audio_tap::{Cut, PauseCuts};
use crate::transcription::{AudioChunk, Timed, SAMPLE_RATE};
use std::sync::Arc;

/// The longest chunk: speech without a pause is handed on after 10 s.
pub const CHUNK_SAMPLES: usize = 10 * SAMPLE_RATE;
/// The shortest chunk that may end at a pause, as on the microphone path.
pub const MIN_CHUNK_SAMPLES: usize = SAMPLE_RATE;
// One block never fills a chunk on its own.
const _: () = assert!(MAX_SAMPLES < MIN_CHUNK_SAMPLES);

/// Timing segments one chunk may hold. Typical native blocks fill a chunk
/// with far fewer; a stream of tiny blocks ends chunks early instead of
/// growing the map. Ending early never joins or drops audio.
pub const MAX_SEGMENTS: usize = 1_024;

const SAMPLES_PER_MS: u64 = (SAMPLE_RATE / 1_000) as u64;
const _: () = assert!(SAMPLE_RATE.is_multiple_of(1_000));

/// One delivered block's share of a chunk: its first sample in the chunk,
/// frame count, and the converted session times of its two boundaries.
#[derive(Clone, Copy, Debug)]
struct Segment {
    first: u64,
    frames: u64,
    start: Position,
    end: Position,
}

/// Bounded mono audio plus its per-block session mapping and source guard.
/// Recheck belongs_to before committing results: Stop cannot retract work
/// already handed to a recognizer.
pub struct NativeChunk {
    audio: AudioChunk,
    segments: Vec<Segment>,
    control: Control,
    session: u64,
}

impl NativeChunk {
    /// Samples for the recognizer. start_ms is the floored session time of
    /// the first sample; use session_ms for anything inside the chunk.
    pub fn audio(&self) -> &AudioChunk {
        &self.audio
    }

    pub fn belongs_to(&self, current_session: u64, current_source: &Control) -> bool {
        self.session == current_session
            && Arc::ptr_eq(&self.control.0, &current_source.0)
            && !self.control.is_cancelled()
    }

    /// Session milliseconds for a recognizer offset measured in this chunk's
    /// nominal 16 kHz samples, including its exclusive end. Offsets past the
    /// audio are refused rather than clamped. Interpolation inside a block is a
    /// fixed linear policy, not a measurement of intermediate device times.
    pub fn session_ms(&self, offset_ms: u64) -> Result<u64, TimingError> {
        let sample = offset_ms
            .checked_mul(SAMPLES_PER_MS)
            .ok_or(TimingError::Overflow)?;
        if sample > self.audio.samples.len() as u64 {
            return Err(TimingError::Clock);
        }
        // Segments are contiguous: a boundary sample starts the later block.
        let index = self
            .segments
            .partition_point(|segment| segment.first <= sample)
            .checked_sub(1)
            .ok_or(TimingError::Clock)?;
        let segment = self.segments[index];
        segment
            .start
            .interpolate(segment.end, sample - segment.first, segment.frames)?
            .millis()
    }
}

/// Lets the transcription worker carry a native chunk through its queue and
/// time each recognized line on the chunk's own clock mapping.
impl Timed for NativeChunk {
    fn audio(&self) -> &AudioChunk {
        &self.audio
    }

    fn session_ms(&self, offset_ms: u64) -> Option<u64> {
        NativeChunk::session_ms(self, offset_ms).ok()
    }

    // Every path that stops or replaces a source cancels its control first,
    // so the chunk's own control answers for the source without the gate.
    // Releasing the capture cancels it too. The source worker cancels on any
    // end of input, so queued audio is withheld by decision, not flushed.
    fn current(&self, session: u64) -> bool {
        self.session == session && !self.control.is_cancelled()
    }
}

/// Assembles native blocks into chunks on the worker that owns the
/// NativeReader. A chunk ends at the first pause after a second of audio, or
/// after ten seconds, by the microphone path's pause rule; a full-length
/// chunk of true silence is skipped. Each push returns at most one chunk. A
/// gap or the segment limit can end a shorter chunk. Stop, cancellation and
/// session replacement never flush pending audio. `finish` can release the last
/// partial chunk at a clean end of input, but the source worker discards it
/// by decision and never calls `finish`.
pub struct NativeChunker {
    control: Control,
    session: u64,
    pending: Vec<f32>,
    segments: Vec<Segment>,
    cuts: PauseCuts,
    terminal: Option<ChunkError>,
}

impl NativeChunker {
    pub(crate) fn new(control: Control, session: u64) -> Self {
        Self {
            control,
            session,
            pending: Vec::with_capacity(CHUNK_SAMPLES + MAX_SAMPLES),
            segments: Vec::with_capacity(MAX_SEGMENTS),
            cuts: PauseCuts::new(MIN_CHUNK_SAMPLES, CHUNK_SAMPLES),
            terminal: None,
        }
    }

    /// Add one block from NativeReader::try_next. Any error is terminal and
    /// discards pending audio.
    pub fn push(
        &mut self,
        block: NativeBlock,
        current_session: u64,
    ) -> Result<Option<NativeChunk>, ChunkError> {
        self.check(current_session)?;
        if !block.timing().belongs_to(self.session, &self.control) {
            return Err(self.retire(ChunkError::Timing(TimingError::SessionChanged)));
        }
        match self.append(&block) {
            Ok(chunk) => Ok(chunk),
            Err(error) => Err(self.retire(error)),
        }
    }

    /// Clean end of input only, after the reader reports Closed. Returns the
    /// final partial chunk, if any; afterwards the chunker stays closed.
    pub fn finish(&mut self, current_session: u64) -> Result<Option<NativeChunk>, ChunkError> {
        self.check(current_session)?;
        let last = self.take_pending();
        self.terminal = Some(ChunkError::Timing(TimingError::Handoff(Rejected::Closed)));
        Ok(last)
    }

    fn check(&mut self, current_session: u64) -> Result<(), ChunkError> {
        if let Some(error) = self.terminal {
            return Err(error);
        }
        if current_session != self.session {
            return Err(self.retire(ChunkError::Timing(TimingError::SessionChanged)));
        }
        if self.control.is_cancelled() {
            let cancelled = TimingError::Handoff(Rejected::Cancelled);
            return Err(self.retire(ChunkError::Timing(cancelled)));
        }
        Ok(())
    }

    fn append(&mut self, block: &NativeBlock) -> Result<Option<NativeChunk>, ChunkError> {
        let timed = block.timing();
        let format = timed.audio().format();
        if format.sample_rate() as usize != SAMPLE_RATE || format.channels() != 1 {
            return Err(ChunkError::UnsupportedFormat);
        }
        let samples = timed.audio().samples();
        let frames = samples.len() as u64;
        let (start, end) = block.bounds();
        // Gap presence comes from exact frames, never rounded milliseconds.
        let ready = if timed.gap().is_some() || self.segments.len() == MAX_SEGMENTS {
            self.cuts.reset();
            self.take_pending()
        } else {
            None
        };
        if frames > 0 {
            self.segments.push(Segment {
                first: self.pending.len() as u64,
                frames,
                start,
                end,
            });
            self.pending.extend_from_slice(samples);
        }
        let Some(cut) = self.cuts.next(&self.pending) else {
            return Ok(ready);
        };
        // A block shorter than the minimum chunk cannot both follow a flush
        // and complete a cut, so each push still returns at most one chunk.
        debug_assert!(ready.is_none());
        match cut {
            Cut::Keep(at) => self.split_pending(at),
            Cut::Skip(at) => {
                self.split_pending(at)?;
                Ok(None)
            }
        }
    }

    /// Hands on the first `at` samples as a chunk and keeps the rest pending.
    /// A block that straddles the cut is divided at one shared boundary,
    /// interpolated as for any position inside a block.
    fn split_pending(&mut self, at: usize) -> Result<Option<NativeChunk>, ChunkError> {
        let at = at as u64;
        let index = self
            .segments
            .partition_point(|segment| segment.first + segment.frames <= at);
        let mut rest = Vec::with_capacity(MAX_SEGMENTS);
        if let Some(&segment) = self.segments.get(index) {
            let inside = at - segment.first;
            if inside > 0 {
                let boundary = segment
                    .start
                    .interpolate(segment.end, inside, segment.frames)
                    .map_err(ChunkError::Timing)?;
                self.segments[index].frames = inside;
                self.segments[index].end = boundary;
                rest.push(Segment {
                    first: 0,
                    frames: segment.frames - inside,
                    start: boundary,
                    end: segment.end,
                });
                rest.extend(self.segments.drain(index + 1..).map(|s| Segment {
                    first: s.first - at,
                    ..s
                }));
            } else {
                rest.extend(self.segments.drain(index..).map(|s| Segment {
                    first: s.first - at,
                    ..s
                }));
            }
        }
        let tail = self.pending.split_off(at as usize);
        let mut head_pending = std::mem::replace(&mut self.pending, tail);
        self.pending
            .reserve(CHUNK_SAMPLES + MAX_SAMPLES - self.pending.len());
        let head_segments = std::mem::replace(&mut self.segments, rest);
        let start_ms = head_segments[0]
            .start
            .millis()
            .expect("a validated position has representable milliseconds");
        head_pending.shrink_to_fit();
        Ok(Some(NativeChunk {
            audio: AudioChunk {
                start_ms,
                samples: head_pending,
            },
            segments: head_segments,
            control: self.control.clone(),
            session: self.session,
        }))
    }

    fn take_pending(&mut self) -> Option<NativeChunk> {
        if self.pending.is_empty() {
            return None;
        }
        let segments = std::mem::replace(&mut self.segments, Vec::with_capacity(MAX_SEGMENTS));
        // Pending audio always has a segment, and Position::new already
        // proved its milliseconds are representable.
        let start_ms = segments[0]
            .start
            .millis()
            .expect("a validated position has representable milliseconds");
        Some(NativeChunk {
            audio: AudioChunk {
                start_ms,
                samples: std::mem::replace(
                    &mut self.pending,
                    Vec::with_capacity(CHUNK_SAMPLES + MAX_SAMPLES),
                ),
            },
            segments,
            control: self.control.clone(),
            session: self.session,
        })
    }

    fn retire(&mut self, error: ChunkError) -> ChunkError {
        self.pending = Vec::new();
        self.segments = Vec::new();
        self.cuts.reset();
        self.terminal = Some(error);
        error
    }
}

#[cfg(test)]
mod tests {
    use super::super::clock::tests::{native_blocks, native_blocks_from};
    use super::*;
    use crate::transcription::{Recognized, Transcriber, Worker};
    use std::{
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc,
        },
        time::Duration,
    };

    /// Fixture clock relations from the clock tests: (timebase rate, source
    /// phase in ns, session ns per source frame). Rates other than 1 model a
    /// source clock running slow or fast against the session.
    const RATES: [(f64, u64, u64); 3] = [
        (0.5, 2_000, 125_000),
        (1.0, 1_000, 62_500),
        (2.0, 500, 31_250),
    ];

    fn expected(phase_ns: u64, frame_ns: u64, frame: u64) -> u64 {
        (250_600_000 + phase_ns + frame * frame_ns) / 1_000_000
    }

    fn contiguous(first: u64, blocks: usize, frames: usize) -> Vec<(u64, usize)> {
        (0..blocks)
            .map(|i| (first + (i * frames) as u64, frames))
            .collect()
    }

    #[test]
    fn recognizer_offsets_follow_the_native_clock_across_a_split_block() {
        for (rate, phase, frame_ns) in RATES {
            // 80 blocks of 2,048 steady (pause-free) frames: the 10 s
            // maximum splits block 79 at frame 160,000.
            let (_gate, control, _capture, blocks) =
                native_blocks(rate, &contiguous(13, 80, 2_048));
            let mut chunker = NativeChunker::new(control.clone(), 7);
            let mut ready = Vec::new();
            for block in blocks {
                ready.extend(chunker.push(block, 7).unwrap());
            }
            assert_eq!(ready.len(), 1, "rate {rate}");
            let full = &ready[0];
            assert_eq!(full.audio().samples.len(), CHUNK_SAMPLES);
            assert!(full.belongs_to(7, &control));
            assert_eq!(full.audio().start_ms, expected(phase, frame_ns, 13));
            // Every recognizer millisecond, including the split boundary and
            // interior block boundaries, lands on the clock's own time.
            for offset in 0..=10_000 {
                assert_eq!(
                    full.session_ms(offset),
                    Ok(expected(phase, frame_ns, 13 + offset * 16)),
                    "rate {rate}, offset {offset}"
                );
            }
            assert_eq!(full.session_ms(10_001), Err(TimingError::Clock));
            assert_eq!(full.session_ms(u64::MAX), Err(TimingError::Overflow));

            // The remainder of the split block continues from the same
            // boundary, not from a restarted nominal origin.
            let rest = chunker.finish(7).unwrap().unwrap();
            assert_eq!(rest.audio().samples.len(), 80 * 2_048 - CHUNK_SAMPLES);
            for offset in [0, 1, 16, 120, 240] {
                assert_eq!(
                    rest.session_ms(offset),
                    Ok(expected(phase, frame_ns, 13 + 160_000 + offset * 16)),
                    "rate {rate}, rest offset {offset}"
                );
            }
            assert_eq!(rest.session_ms(241), Err(TimingError::Clock));
            assert_eq!(
                chunker.finish(7).err(),
                Some(ChunkError::Timing(TimingError::Handoff(Rejected::Closed)))
            );
        }
    }

    /// Fictional "speech" (a steady tone level) and pauses, in milliseconds,
    /// cut into blocks of the given sizes in turn, starting at frame 13.
    fn spoken(parts: &[(bool, u64)], sizes: &[usize]) -> (Vec<f32>, Vec<(u64, Vec<f32>)>) {
        let mut audio = Vec::new();
        for (index, &(speech, ms)) in parts.iter().enumerate() {
            for n in 0..ms * 16 {
                // Varied but always well above the sound floor while speaking.
                audio.push(if speech {
                    0.2 + ((n + index as u64) % 7) as f32 * 0.01
                } else {
                    0.0
                });
            }
        }
        let mut packets = Vec::new();
        let (mut at, mut size) = (0, 0);
        while at < audio.len() {
            let len = sizes[size % sizes.len()].min(audio.len() - at);
            packets.push((13 + at as u64, audio[at..at + len].to_vec()));
            at += len;
            size += 1;
        }
        (audio, packets)
    }

    fn all_chunks(packets: &[(u64, Vec<f32>)]) -> Vec<NativeChunk> {
        let (_gate, control, _capture, blocks) = native_blocks_from(1.0, packets);
        let mut chunker = NativeChunker::new(control, 7);
        let mut ready = Vec::new();
        for block in blocks {
            ready.extend(chunker.push(block, 7).unwrap());
        }
        ready.extend(chunker.finish(7).unwrap());
        ready
    }

    #[test]
    fn a_chunk_ends_at_a_pause_once_it_holds_a_second_of_speech() {
        // 1.5 s of speech, a 300 ms pause, then more speech: the chunk ends
        // after 200 ms of the pause, at 1.7 s, inside a block.
        let (_, packets) = spoken(&[(true, 1_500), (false, 300), (true, 1_200)], &[1_000]);
        let ready = all_chunks(&packets);
        assert_eq!(ready.len(), 2);
        assert_eq!(ready[0].audio().samples.len(), 1_700 * 16);
        assert_eq!(ready[0].audio().start_ms, expected(1_000, 62_500, 13));
        assert_eq!(
            ready[1].session_ms(0),
            Ok(expected(1_000, 62_500, 13 + 1_700 * 16))
        );
        assert_eq!(ready[1].audio().samples.len(), (100 + 1_200) * 16);
    }

    #[test]
    fn a_pause_before_the_first_second_does_not_end_a_chunk() {
        // A pause at 0.5 s is too early; the next one, after 1.8 s, ends it.
        let (_, packets) = spoken(
            &[
                (true, 500),
                (false, 300),
                (true, 1_000),
                (false, 300),
                (true, 500),
            ],
            &[512],
        );
        let ready = all_chunks(&packets);
        assert_eq!(ready.len(), 2);
        assert_eq!(
            ready[0].audio().samples.len(),
            (500 + 300 + 1_000 + 200) * 16
        );
        assert!(ready[0].audio().samples.len() >= MIN_CHUNK_SAMPLES);
    }

    #[test]
    fn steady_speech_is_handed_on_at_ten_seconds() {
        let (_, packets) = spoken(&[(true, 25_000)], &[2_048]);
        let ready = all_chunks(&packets);
        let lengths: Vec<usize> = ready.iter().map(|c| c.audio().samples.len()).collect();
        assert_eq!(lengths, [CHUNK_SAMPLES, CHUNK_SAMPLES, 5_000 * 16]);
    }

    #[test]
    fn cuts_neither_lose_nor_repeat_audio_and_keep_the_clock_continuous() {
        // About a minute of irregular speech and pauses in irregular blocks.
        let mut parts = Vec::new();
        for i in 0..40u64 {
            parts.push((true, 300 + (i * 397) % 2_900));
            parts.push((false, 50 + (i * 131) % 600));
        }
        let (audio, packets) = spoken(&parts, &[1, 7, 160, 2_048, 333, 1_024, 2_000, 64]);
        let ready = all_chunks(&packets);
        assert!(ready.len() > 10, "pauses end chunks");
        let mut joined = Vec::new();
        for chunk in &ready {
            assert!(chunk.audio().samples.len() <= CHUNK_SAMPLES);
            assert_eq!(
                chunk.session_ms(0),
                Ok(expected(1_000, 62_500, 13 + joined.len() as u64)),
                "each chunk starts where the previous one ended"
            );
            joined.extend_from_slice(&chunk.audio().samples);
        }
        assert_eq!(joined, audio);
        // Every chunk but the last held at least the minimum before its cut.
        assert!(ready[..ready.len() - 1]
            .iter()
            .all(|c| c.audio().samples.len() >= MIN_CHUNK_SAMPLES));
    }

    #[test]
    fn ten_seconds_of_silence_is_skipped_and_later_audio_keeps_its_time() {
        let (_, packets) = spoken(&[(false, 12_000), (true, 2_000)], &[2_048]);
        let ready = all_chunks(&packets);
        // The silent first ten seconds never reach the recognizer.
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].audio().samples.len(), (2_000 + 2_000) * 16);
        assert_eq!(
            ready[0].session_ms(0),
            Ok(expected(1_000, 62_500, 13 + CHUNK_SAMPLES as u64))
        );
        // A short pause between words is kept, not skipped.
        let (audio, packets) = spoken(&[(true, 1_200), (false, 150), (true, 900)], &[700]);
        let joined: Vec<f32> = all_chunks(&packets)
            .iter()
            .flat_map(|c| c.audio().samples.clone())
            .collect();
        assert_eq!(joined, audio);
    }

    #[test]
    fn a_gap_ends_the_chunk_without_joining_audio_across_it() {
        let (rate, phase, frame_ns) = RATES[2];
        let (_gate, control, _capture, blocks) =
            native_blocks(rate, &[(13, 2_048), (13 + 2_048 + 100, 512)]);
        let mut chunker = NativeChunker::new(control, 7);
        let mut blocks = blocks.into_iter();
        assert!(chunker.push(blocks.next().unwrap(), 7).unwrap().is_none());
        let before = chunker.push(blocks.next().unwrap(), 7).unwrap().unwrap();
        assert_eq!(before.audio().samples.len(), 2_048);
        assert_eq!(
            before.session_ms(128),
            Ok(expected(phase, frame_ns, 13 + 2_048))
        );
        assert_eq!(before.session_ms(129), Err(TimingError::Clock));
        let after = chunker.finish(7).unwrap().unwrap();
        assert_eq!(after.audio().samples.len(), 512);
        assert_eq!(after.session_ms(0), Ok(expected(phase, frame_ns, 2_161)));
        assert_eq!(
            after.session_ms(32),
            Ok(expected(phase, frame_ns, 2_161 + 512))
        );
    }

    #[test]
    fn tiny_blocks_end_a_chunk_at_the_segment_limit() {
        let (rate, phase, frame_ns) = RATES[0];
        let (_gate, control, _capture, blocks) =
            native_blocks(rate, &contiguous(13, MAX_SEGMENTS + 16, 1));
        let mut chunker = NativeChunker::new(control, 7);
        let mut ready = Vec::new();
        for block in blocks {
            ready.extend(chunker.push(block, 7).unwrap());
        }
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].audio().samples.len(), MAX_SEGMENTS);
        assert_eq!(ready[0].segments.len(), MAX_SEGMENTS);
        assert_eq!(
            ready[0].session_ms(16),
            Ok(expected(phase, frame_ns, 13 + 256))
        );
        let rest = chunker.finish(7).unwrap().unwrap();
        assert_eq!(rest.audio().samples.len(), 16);
        let limit = MAX_SEGMENTS as u64;
        assert_eq!(
            rest.session_ms(0),
            Ok(expected(phase, frame_ns, 13 + limit))
        );
        assert_eq!(
            rest.session_ms(1),
            Ok(expected(phase, frame_ns, 13 + limit + 16))
        );
    }

    #[test]
    fn stop_and_session_replacement_retire_without_flushing() {
        // Stop: pending audio is discarded, and released work no longer belongs.
        let (gate, control, _capture, blocks) = native_blocks(1.0, &contiguous(13, 2, 2_048));
        let mut chunker = NativeChunker::new(control.clone(), 7);
        let mut blocks = blocks.into_iter();
        chunker.push(blocks.next().unwrap(), 7).unwrap();
        gate.stop(&control).unwrap();
        let cancelled = ChunkError::Timing(TimingError::Handoff(Rejected::Cancelled));
        assert_eq!(chunker.finish(7).err(), Some(cancelled));
        assert_eq!(
            chunker.push(blocks.next().unwrap(), 7).err(),
            Some(cancelled)
        );

        // A replaced session cannot flush or accept more audio.
        let (_gate, control, _capture, blocks) = native_blocks(1.0, &contiguous(13, 2, 2_048));
        let mut chunker = NativeChunker::new(control.clone(), 7);
        let mut blocks = blocks.into_iter();
        chunker.push(blocks.next().unwrap(), 7).unwrap();
        let changed = ChunkError::Timing(TimingError::SessionChanged);
        assert_eq!(chunker.finish(8).err(), Some(changed));
        assert_eq!(chunker.push(blocks.next().unwrap(), 7).err(), Some(changed));
    }

    #[test]
    fn a_block_from_another_source_is_refused() {
        let (_gate, other, _capture, mut foreign) = native_blocks(1.0, &[(13, 64)]);
        let (_gate2, control, _capture2, _) = native_blocks(1.0, &[(13, 64)]);
        let mut chunker = NativeChunker::new(control.clone(), 7);
        assert!(!Arc::ptr_eq(&other.0, &control.0));
        assert_eq!(
            chunker.push(foreign.remove(0), 7).err(),
            Some(ChunkError::Timing(TimingError::SessionChanged))
        );
    }

    #[test]
    fn a_chunk_released_by_stop_no_longer_belongs() {
        let (gate, control, _capture, blocks) = native_blocks(1.0, &contiguous(13, 80, 2_048));
        let mut chunker = NativeChunker::new(control.clone(), 7);
        let mut ready = None;
        for block in blocks {
            ready = ready.or(chunker.push(block, 7).unwrap());
        }
        let chunk = ready.unwrap();
        assert!(chunk.belongs_to(7, &control));
        assert!(!chunk.belongs_to(8, &control));
        gate.stop(&control).unwrap();
        assert!(!chunk.belongs_to(7, &control));
    }

    /// Returns the same scripted offsets for every chunk, counting calls.
    /// With a gate, reports each call and waits for the test to open it.
    struct Script {
        offsets: Vec<u64>,
        calls: Arc<AtomicU64>,
        gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    }

    impl Transcriber for Script {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some((started, open)) = &self.gate {
                let _ = started.send(());
                let _ = open.recv();
            }
            Ok(self
                .offsets
                .iter()
                .map(|&offset_ms| Recognized {
                    offset_ms,
                    speaker: "Speaker 1".into(),
                    text: format!("Line at {offset_ms}."),
                })
                .collect())
        }
    }

    fn collect() -> (
        impl FnMut(u64, crate::engine::Segment) -> Result<(), String> + Send + 'static,
        mpsc::Receiver<u64>,
    ) {
        let (report, delivered) = mpsc::channel();
        let sink = move |_, segment: crate::engine::Segment| {
            let _ = report.send(segment.at_ms);
            Ok(())
        };
        (sink, delivered)
    }

    fn chunks(control: &Control, blocks: Vec<NativeBlock>) -> Vec<NativeChunk> {
        let mut chunker = NativeChunker::new(control.clone(), 7);
        let mut ready = Vec::new();
        for block in blocks {
            ready.extend(chunker.push(block, 7).unwrap());
        }
        ready.extend(chunker.finish(7).unwrap());
        ready
    }

    #[test]
    fn a_queued_chunk_times_recognized_lines_on_the_native_clock() {
        for (rate, phase, frame_ns) in RATES {
            let (_gate, control, _capture, blocks) =
                native_blocks(rate, &contiguous(13, 80, 2_048));
            let ready = chunks(&control, blocks);
            assert_eq!(ready.len(), 2, "a full chunk and the split remainder");
            let calls = Arc::new(AtomicU64::new(0));
            // Out of order, with one offset past each chunk's audio.
            let script = Script {
                offsets: vec![72, 0, 10_001, 40],
                calls: calls.clone(),
                gate: None,
            };
            let (sink, delivered) = collect();
            let worker = Worker::start(7, 4, script, sink);
            for chunk in ready {
                assert!(worker.submit(chunk).is_ok());
            }
            let stats = worker.finish(Duration::from_secs(5));
            assert_eq!(
                (
                    stats.chunks,
                    stats.accepted,
                    stats.out_of_range,
                    stats.stale
                ),
                (2, 6, 2, 0),
                "rate {rate}"
            );
            let times: Vec<u64> = delivered.try_iter().collect();
            let at = |chunk_frame: u64, offset: u64| {
                expected(phase, frame_ns, 13 + chunk_frame + offset * 16)
            };
            assert_eq!(
                times,
                [
                    at(0, 0),
                    at(0, 40),
                    at(0, 72),
                    at(160_000, 0),
                    at(160_000, 40),
                    at(160_000, 72)
                ],
                "rate {rate}"
            );
            if rate != 1.0 {
                // A floored start plus the nominal offset would be wrong here.
                assert_ne!(times[2], times[0] + 72, "rate {rate}");
            }
        }
    }

    #[test]
    fn stop_during_recognition_withholds_the_result_and_skips_queued_audio() {
        let (gate, control, _capture, blocks) = native_blocks(1.0, &contiguous(13, 90, 2_048));
        let ready = chunks(&control, blocks);
        assert_eq!(ready.len(), 2);
        let calls = Arc::new(AtomicU64::new(0));
        let (started, recognizing) = mpsc::channel();
        let (open, opened) = mpsc::channel();
        let script = Script {
            offsets: vec![0, 100],
            calls: calls.clone(),
            gate: Some((started, opened)),
        };
        let (sink, delivered) = collect();
        let worker = Worker::start(7, 4, script, sink);
        for chunk in ready {
            assert!(worker.submit(chunk).is_ok());
        }
        recognizing.recv().unwrap(); // The first chunk is being recognized.
        gate.stop(&control).unwrap();
        open.send(()).unwrap();
        // The worker itself was never cancelled: the source's Stop alone
        // keeps both chunks out of the transcript.
        let stats = worker.finish(Duration::from_secs(5));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "queued audio not recognized"
        );
        assert_eq!((stats.chunks, stats.accepted, stats.stale), (1, 0, 2));
        assert!(delivered.try_recv().is_err());
    }

    #[test]
    fn a_chunk_from_another_session_is_never_recognized() {
        let (_gate, control, _capture, blocks) = native_blocks(1.0, &contiguous(13, 2, 2_048));
        let ready = chunks(&control, blocks);
        let calls = Arc::new(AtomicU64::new(0));
        let script = Script {
            offsets: vec![0],
            calls: calls.clone(),
            gate: None,
        };
        let (sink, delivered) = collect();
        let worker = Worker::start(8, 4, script, sink);
        for chunk in ready {
            assert!(worker.submit(chunk).is_ok());
        }
        let stats = worker.finish(Duration::from_secs(5));
        assert_eq!((calls.load(Ordering::SeqCst), stats.stale), (0, 1));
        assert!(delivered.try_recv().is_err());
    }
}
