//! Audio tap: carries microphone samples from the real-time capture callback
//! to a transcription chunker without allocating, locking, or blocking in
//! the callback. The callback side downmixes to mono and pushes into a
//! fixed-size lock-free ring; when the ring is full, samples are dropped and
//! counted. The chunker side, on its own thread, resamples to 16 kHz and
//! produces chunks of a set length on the session clock; a drop ends the
//! current chunk early and leaves a gap. Nothing is written to
//! disk or kept after a chunk is handed on.

use crate::transcription::{AudioChunk, SAMPLE_RATE};
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

/// Seconds of device audio the ring can hold before samples are dropped.
pub const RING_SECONDS: usize = 4;
/// Level frames used to find pauses: 20 ms of 16 kHz audio.
const FRAME: usize = SAMPLE_RATE / 50;
/// How long a pause must last before a chunk may end in it.
pub const PAUSE_MS: u64 = 200;
/// A frame below this level always counts as quiet.
const QUIET_FLOOR: f32 = 0.003;
/// A frame at least this loud counts as sound worth transcribing.
const SOUND_FLOOR: f32 = 0.01;

/// Shared counter of samples dropped because the ring was full.
#[derive(Default)]
pub struct Overruns(AtomicU64);

impl Overruns {
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}

/// Creates a tap for a device delivering `channels` interleaved channels at
/// `device_rate` Hz. The `TapInput` goes to the capture callback; the
/// `Chunker` stays with the transcription side.
pub fn tap(device_rate: u32, channels: u16, chunk_ms: u64) -> (TapInput, Chunker) {
    let capacity = (device_rate as usize).max(1) * RING_SECONDS;
    let (producer, consumer) = RingBuffer::new(capacity);
    let overruns = Arc::new(Overruns::default());
    (
        TapInput {
            producer,
            channels: channels.max(1) as usize,
            overruns: overruns.clone(),
            frame_sum: 0.0,
            frame_samples: 0,
        },
        Chunker {
            consumer,
            resampler: Resampler::new(device_rate),
            pending: Vec::with_capacity(SAMPLE_RATE * chunk_ms as usize / 1_000),
            chunk_samples: (SAMPLE_RATE as u64 * chunk_ms / 1_000).max(1) as usize,
            emitted: 0,
            overruns,
            counted_overruns: 0,
            gap_applied: 0,
            device_rate: device_rate.max(1),
            min_samples: None,
            skipped: 0,
        },
    )
}

/// The callback side. Every method is allocation-free and wait-free.
pub struct TapInput {
    producer: Producer<f32>,
    channels: usize,
    overruns: Arc<Overruns>,
    /// A frame split across two callbacks continues in the next one.
    frame_sum: f32,
    frame_samples: usize,
}

impl TapInput {
    /// Downmixes interleaved samples to mono and queues them. Samples that do
    /// not fit are dropped and counted, never waited for. Pass a non-allocating
    /// iterator, such as a mapped slice from the capture callback.
    pub fn push_interleaved(&mut self, samples: impl Iterator<Item = f32>) {
        for sample in samples {
            self.frame_sum += if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            self.frame_samples += 1;
            if self.frame_samples == self.channels {
                if self
                    .producer
                    .push(self.frame_sum / self.channels as f32)
                    .is_err()
                {
                    self.overruns.0.fetch_add(1, Ordering::Release);
                }
                self.frame_sum = 0.0;
                self.frame_samples = 0;
            }
        }
    }
}

/// The transcription side: drains the ring, resamples, and cuts chunks.
pub struct Chunker {
    consumer: Consumer<f32>,
    resampler: Resampler,
    pending: Vec<f32>,
    chunk_samples: usize,
    /// 16 kHz samples already emitted, plus gaps for dropped audio, which
    /// sets each chunk's start time.
    emitted: u64,
    overruns: Arc<Overruns>,
    /// Dropped device samples already accounted for as a gap.
    counted_overruns: u64,
    /// 16 kHz samples of gap already added to `emitted`.
    gap_applied: u64,
    device_rate: u32,
    /// With pause cuts on, the shortest chunk that may end at a pause.
    min_samples: Option<usize>,
    skipped: u64,
}

impl Chunker {
    /// Ends a chunk at the first pause after `min_ms` of audio, instead of
    /// always at the full chunk length, which becomes the longest a chunk can
    /// be. Words are less often cut in half, and a line can reach the
    /// recognizer sooner. A pause is `PAUSE_MS` of audio below a tenth of the
    /// chunk's typical (median) sound level so far, after some sound. A
    /// full-length chunk in which every sample is below the quiet floor is
    /// skipped rather than transcribed and counted in `skipped`; later
    /// chunks keep their session times.
    pub fn cut_at_pauses(&mut self, min_ms: u64) {
        let min = (SAMPLE_RATE as u64 * min_ms / 1_000) as usize;
        self.min_samples = Some(min.max(FRAME).min(self.chunk_samples));
    }

    /// The next cut of pending audio, if one is due.
    fn next_cut(&self) -> Option<Cut> {
        let Some(min) = self.min_samples else {
            return (self.pending.len() >= self.chunk_samples)
                .then_some(Cut::Keep(self.chunk_samples));
        };
        let limit = self.pending.len().min(self.chunk_samples);
        let needed = (PAUSE_MS as usize * SAMPLE_RATE / 1_000).div_ceil(FRAME);
        // Each frame is judged against the typical level of the sound before
        // it: the median, so one loud thump cannot make ordinary speech look
        // like a pause. Only earlier frames count, so the cut does not depend
        // on how often the chunker drains.
        let (mut loudest, mut run) = (0.0f32, 0);
        let mut sounds: Vec<f32> = Vec::new();
        for (index, frame) in self.pending[..limit].chunks_exact(FRAME).enumerate() {
            let level = (frame.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
            loudest = loudest.max(level);
            let typical = if sounds.is_empty() {
                level
            } else {
                let mut sorted = sounds.clone();
                sorted.sort_unstable_by(f32::total_cmp);
                sorted[sorted.len() / 2]
            };
            if level < (typical * 0.1).max(QUIET_FLOOR) {
                run += 1;
            } else {
                run = 0;
            }
            if level >= SOUND_FLOOR {
                sounds.push(level);
            }
            let end = (index + 1) * FRAME;
            if loudest >= SOUND_FLOOR && run >= needed && end >= min {
                return Some(Cut::Keep(end));
            }
        }
        if self.pending.len() < self.chunk_samples {
            return None;
        }
        // Only true silence is skipped, judged over the whole chunk, so soft
        // speech still reaches the recognizer.
        let silent = self.chunk_samples >= FRAME
            && self.pending[..self.chunk_samples]
                .iter()
                .all(|sample| sample.abs() < QUIET_FLOOR);
        Some(if silent {
            Cut::Skip(self.chunk_samples)
        } else {
            Cut::Keep(self.chunk_samples)
        })
    }

    /// Moves everything queued so far through the resampler and returns any
    /// complete chunks. `session_start_ms` is the session time at which the
    /// tap started, so chunk times line up with the engine's clock.
    pub fn drain(&mut self, session_start_ms: u64) -> Vec<AudioChunk> {
        // Read the drop count before the queue length. While the ring is full
        // the callback cannot add samples, so every drop counted here came
        // after every sample queued now. Samples that arrive during this
        // drain wait for the next one, behind their own drops.
        let dropped_total = self.overruns.get();
        let queued = self.consumer.slots();
        for _ in 0..queued {
            match self.consumer.pop() {
                Ok(sample) => self.resampler.push(sample, &mut self.pending),
                Err(_) => break,
            }
        }
        let mut chunks = vec![];
        while let Some(cut) = self.next_cut() {
            match cut {
                Cut::Keep(length) => {
                    let samples: Vec<f32> = self.pending.drain(..length).collect();
                    chunks.push(self.chunk(session_start_ms, samples));
                }
                Cut::Skip(length) => {
                    self.pending.drain(..length);
                    self.emitted += length as u64;
                    self.skipped += 1;
                }
            }
        }
        // Account for dropped audio as a gap, ending the current chunk early so
        // later chunks keep their true times. The gap comes from the running
        // total, so repeated small drops do not lose fractions of a sample.
        if dropped_total > self.counted_overruns {
            self.counted_overruns = dropped_total;
            if !self.pending.is_empty() {
                let samples = std::mem::take(&mut self.pending);
                chunks.push(self.chunk(session_start_ms, samples));
            }
            let gap_total = dropped_total * SAMPLE_RATE as u64 / self.device_rate as u64;
            self.emitted += gap_total - self.gap_applied;
            self.gap_applied = gap_total;
        }
        chunks
    }

    /// Returns every remaining chunk, including the final partial one, when
    /// capture stops.
    pub fn finish(&mut self, session_start_ms: u64) -> Vec<AudioChunk> {
        // Capture should already have stopped. If the callback is still
        // pushing, stop after a few passes rather than chase it forever.
        let mut chunks = vec![];
        for _ in 0..4 {
            let before = self.consumer.slots();
            chunks.extend(self.drain(session_start_ms));
            if before == 0 {
                break;
            }
        }
        let partial = std::mem::take(&mut self.pending);
        if !partial.is_empty() {
            chunks.push(self.chunk(session_start_ms, partial));
        }
        chunks
    }

    pub fn overruns(&self) -> u64 {
        self.overruns.get()
    }

    /// Silent chunks skipped instead of transcribed.
    pub fn skipped(&self) -> u64 {
        self.skipped
    }

    fn chunk(&mut self, session_start_ms: u64, samples: Vec<f32>) -> AudioChunk {
        let start_ms = session_start_ms + self.emitted * 1_000 / SAMPLE_RATE as u64;
        self.emitted += samples.len() as u64;
        AudioChunk { start_ms, samples }
    }
}

/// Where to cut pending audio: hand a chunk on, or skip silence.
enum Cut {
    Keep(usize),
    Skip(usize),
}

/// Converts mono audio at the device rate to 16 kHz. Each output sample
/// averages the input samples that fall within its period, which gives only
/// minimal anti-aliasing when downsampling; upsampling interpolates linearly.
/// Checked to work for speech recognition on synthetic speech; not a
/// high-fidelity resampler.
struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Position of the next output sample, in input samples.
    next: f64,
    position: f64,
    sum: f32,
    count: u32,
    previous: f32,
}

impl Resampler {
    fn new(device_rate: u32) -> Self {
        let step = device_rate.max(1) as f64 / SAMPLE_RATE as f64;
        Self {
            step,
            next: step,
            position: 0.0,
            sum: 0.0,
            count: 0,
            previous: 0.0,
        }
    }

    fn push(&mut self, sample: f32, out: &mut Vec<f32>) {
        if self.step >= 1.0 {
            // Downsampling or same rate: average each output period.
            self.sum += sample;
            self.count += 1;
            self.position += 1.0;
            while self.position >= self.next {
                out.push(self.sum / self.count.max(1) as f32);
                self.sum = 0.0;
                self.count = 0;
                self.next += self.step;
            }
        } else {
            // Upsampling: interpolate between the previous and this sample.
            self.position += 1.0;
            while self.next <= self.position {
                let fraction = (self.next - (self.position - 1.0)) as f32;
                out.push(self.previous + (sample - self.previous) * fraction);
                self.next += self.step;
            }
            self.previous = sample;
        }
        // Keep the counters small over long sessions.
        if self.position > 1.0e6 {
            self.position -= 1.0e6;
            self.next -= 1.0e6;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn tone(rate: u32, hz: f32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|n| 0.5 * (2.0 * PI * hz * n as f32 / rate as f32).sin())
            .collect()
    }

    /// Strength of `hz` in a 16 kHz signal (correlation with a sine and cosine).
    fn strength(samples: &[f32], hz: f32) -> f32 {
        let (mut s, mut c) = (0.0, 0.0);
        for (n, x) in samples.iter().enumerate() {
            let phase = 2.0 * PI * hz * n as f32 / SAMPLE_RATE as f32;
            s += x * phase.sin();
            c += x * phase.cos();
        }
        (s * s + c * c).sqrt() * 2.0 / samples.len() as f32
    }

    #[test]
    fn common_device_rates_become_16_khz_chunks_with_session_times() {
        for rate in [48_000, 44_100, 16_000, 8_000] {
            let (mut input, mut chunker) = tap(rate, 1, 1_000);
            // A little over three seconds, so rounding at the edge cannot
            // leave the third chunk one sample short.
            input.push_interleaved(tone(rate, 440.0, 3.05).into_iter());
            let chunks = chunker.drain(10_000);
            assert_eq!(chunks.len(), 3, "rate {rate}");
            for (index, chunk) in chunks.iter().enumerate() {
                assert_eq!(chunk.samples.len(), SAMPLE_RATE, "rate {rate}");
                assert_eq!(chunk.start_ms, 10_000 + index as u64 * 1_000, "rate {rate}");
            }
            // A speech-band tone keeps its strength (0.5 amplitude) through resampling.
            let level = strength(&chunks[1].samples, 440.0);
            assert!((0.45..0.55).contains(&level), "rate {rate}: level {level}");
        }
    }

    #[test]
    fn stereo_is_downmixed_to_mono() {
        let (mut input, mut chunker) = tap(16_000, 2, 1_000);
        // Left carries the tone, right is silent: the mix has half the level.
        let left = tone(16_000, 440.0, 1.0);
        let interleaved = left.iter().flat_map(|&l| [l, 0.0]);
        input.push_interleaved(interleaved);
        let chunks = chunker.drain(0);
        let level = strength(&chunks[0].samples, 440.0);
        assert!((0.22..0.28).contains(&level), "level {level}");
    }

    #[test]
    fn a_full_ring_drops_and_counts_samples_instead_of_blocking() {
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        let capacity = 16_000 * RING_SECONDS;
        input.push_interleaved(std::iter::repeat_n(0.1, capacity + 500));
        assert_eq!(chunker.overruns(), 500);
        assert_eq!(chunker.drain(0).len(), RING_SECONDS);
    }

    #[test]
    fn repeated_small_drops_keep_their_fractions() {
        // At 44.1 kHz one dropped sample is 0.36 of an output sample. Forty
        // separate one-sample drops must add up rather than round to nothing,
        // so the next chunk starts later by their total.
        let (mut input, mut chunker) = tap(44_100, 1, 1_000);
        let capacity = 44_100 * RING_SECONDS;
        let mut emitted_ms = 0;
        for _ in 0..40 {
            input.push_interleaved(std::iter::repeat_n(0.0, capacity + 1)); // one dropped
            for chunk in chunker.drain(0) {
                emitted_ms =
                    chunk.start_ms + chunk.samples.len() as u64 * 1_000 / SAMPLE_RATE as u64;
            }
        }
        input.push_interleaved(std::iter::repeat_n(0.0, 44_100));
        let next = chunker.drain(0).remove(0);
        // 40 dropped samples at 44.1 kHz are 0.9 ms; rounding each one down
        // separately would add nothing at all.
        let gap_ms = 40 * 1_000 / 44_100;
        assert!(
            next.start_ms >= emitted_ms + gap_ms,
            "{} vs {}",
            next.start_ms,
            emitted_ms
        );
        assert_eq!(chunker.overruns(), 40);
        // At the sample level, the gap is the total's share, not 40 x 0.
        assert_eq!(chunker.gap_applied, 40 * SAMPLE_RATE as u64 / 44_100);
    }

    #[test]
    fn invalid_samples_are_silenced_and_loud_ones_clipped() {
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        let mut samples = vec![f32::NAN, f32::INFINITY, 4.0, -4.0];
        samples.resize(16_000, 0.0);
        input.push_interleaved(samples.into_iter());
        let chunk = &chunker.drain(0)[0];
        assert_eq!(&chunk.samples[..4], &[0.0, 0.0, 1.0, -1.0]);
    }

    #[test]
    fn finish_returns_every_remaining_chunk_once() {
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        input.push_interleaved(std::iter::repeat_n(0.0, 24_000));
        // Nothing drained yet: a full chunk and a partial one remain.
        let rest = chunker.finish(0);
        let summary: Vec<_> = rest.iter().map(|c| (c.start_ms, c.samples.len())).collect();
        assert_eq!(summary, [(0, 16_000), (1_000, 8_000)]);
        assert!(chunker.finish(0).is_empty());
    }

    #[test]
    fn a_frame_split_across_callbacks_is_kept() {
        let (mut input, mut chunker) = tap(16_000, 2, 1_000);
        let stereo = vec![0.5; 32_000];
        input.push_interleaved(stereo[..3].iter().copied());
        input.push_interleaved(stereo[3..].iter().copied());
        let chunks = chunker.drain(0);
        assert_eq!((chunks.len(), chunks[0].samples.len()), (1, 16_000));
    }

    #[test]
    fn dropped_audio_leaves_a_gap_so_later_chunks_keep_their_times() {
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        let capacity = 16_000 * RING_SECONDS;
        // Fill the ring and drop one second, then drain and continue.
        input.push_interleaved(std::iter::repeat_n(0.0, capacity + 16_000));
        let first = chunker.drain(0);
        assert_eq!(first.last().unwrap().start_ms, 3_000);
        input.push_interleaved(std::iter::repeat_n(0.0, 16_000));
        let next = chunker.drain(0);
        assert_eq!(next[0].start_ms, 5_000, "one dropped second is skipped");
    }

    #[test]
    fn chunk_times_stay_exact_over_a_long_session() {
        let (mut input, mut chunker) = tap(48_000, 1, 3_000);
        let mut chunks = vec![];
        for _ in 0..600 {
            // One hour in one-second callbacks would be slow; ten minutes is enough.
            input.push_interleaved(std::iter::repeat_n(0.0, 48_000));
            chunks.extend(chunker.drain(0));
        }
        assert_eq!(chunks.len(), 200);
        assert_eq!(chunks.last().unwrap().start_ms, 597_000);
        assert!(chunks.iter().all(|chunk| chunk.samples.len() == 48_000));
    }

    /// A tone for each `(seconds, loud)` part, silence otherwise, at 16 kHz.
    fn speech_like(parts: &[(f32, bool)]) -> Vec<f32> {
        parts
            .iter()
            .flat_map(|&(seconds, loud)| {
                let tone = tone(SAMPLE_RATE as u32, 220.0, seconds);
                tone.into_iter()
                    .map(move |x| if loud { x * 0.3 } else { 0.0 })
            })
            .collect()
    }

    fn feed(input: &mut TapInput, chunker: &mut Chunker, audio: &[f32]) -> Vec<AudioChunk> {
        let mut chunks = vec![];
        for block in audio.chunks(SAMPLE_RATE / 10) {
            input.push_interleaved(block.iter().copied());
            chunks.extend(chunker.drain(0));
        }
        chunks
    }

    #[test]
    fn a_pause_after_the_minimum_ends_the_chunk_there() {
        let (mut input, mut chunker) = tap(16_000, 1, 4_000);
        chunker.cut_at_pauses(1_000);
        let audio = speech_like(&[(1.2, true), (0.4, false), (1.5, true), (0.4, false)]);
        let chunks = feed(&mut input, &mut chunker, &audio);
        assert_eq!(chunks.len(), 2, "one chunk per spoken part");
        // The first ends 200 ms into its pause; the second starts there.
        assert_eq!(chunks[0].samples.len(), 1_400 * SAMPLE_RATE / 1_000);
        assert_eq!(chunks[1].start_ms, 1_400);
        // The rest of the first pause, the second part, and 200 ms of its pause.
        assert_eq!(chunks[1].samples.len(), 1_900 * SAMPLE_RATE / 1_000);
    }

    #[test]
    fn a_pause_before_the_minimum_does_not_cut_a_short_chunk() {
        let (mut input, mut chunker) = tap(16_000, 1, 4_000);
        chunker.cut_at_pauses(1_000);
        let audio = speech_like(&[(0.4, true), (0.3, false), (1.0, true), (0.3, false)]);
        let chunks = feed(&mut input, &mut chunker, &audio);
        assert_eq!(chunks.len(), 1);
        assert!(
            chunks[0].samples.len() >= SAMPLE_RATE,
            "at least the minimum"
        );
    }

    #[test]
    fn without_pauses_chunks_still_end_at_the_full_length() {
        let (mut input, mut chunker) = tap(16_000, 1, 2_000);
        chunker.cut_at_pauses(500);
        let chunks = feed(&mut input, &mut chunker, &speech_like(&[(4.0, true)]));
        let lengths: Vec<usize> = chunks.iter().map(|chunk| chunk.samples.len()).collect();
        assert_eq!(lengths, vec![2 * SAMPLE_RATE; 2]);
    }

    #[test]
    fn silence_is_skipped_but_later_speech_keeps_its_time() {
        let (mut input, mut chunker) = tap(16_000, 1, 2_000);
        chunker.cut_at_pauses(500);
        // Five silent seconds, then speech without a pause.
        let chunks = feed(
            &mut input,
            &mut chunker,
            &speech_like(&[(5.0, false), (2.5, true)]),
        );
        // The two silent chunks are skipped; the one with speech keeps its time.
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].start_ms, 4_000);
        assert_eq!(chunker.skipped(), 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.samples.iter().any(|x| x.abs() > 0.1)));
    }

    #[test]
    fn a_later_loud_sound_does_not_turn_earlier_speech_into_a_pause() {
        let quiet: Vec<f32> = tone(SAMPLE_RATE as u32, 220.0, 1.5)
            .iter()
            .map(|x| x * 0.04)
            .collect();
        let thump: Vec<f32> = tone(SAMPLE_RATE as u32, 220.0, 0.1)
            .iter()
            .map(|x| x * 0.9)
            .collect();
        let audio: Vec<f32> = quiet.iter().chain(&thump).chain(&quiet).copied().collect();
        for block_ms in [100, 250, 1_000] {
            let (mut input, mut chunker) = tap(16_000, 1, 3_000);
            chunker.cut_at_pauses(1_000);
            let mut chunks = vec![];
            for block in audio.chunks(SAMPLE_RATE * block_ms / 1_000) {
                input.push_interleaved(block.iter().copied());
                chunks.extend(chunker.drain(0));
            }
            // Continuous speech with no pause: only the full-length cut.
            assert_eq!(chunks.len(), 1, "drained every {block_ms} ms");
            assert_eq!(chunks[0].samples.len(), 3 * SAMPLE_RATE);
        }
    }

    #[test]
    fn a_tiny_chunk_length_with_pause_cuts_does_not_panic() {
        let (mut input, mut chunker) = tap(16_000, 1, 10);
        chunker.cut_at_pauses(1_000);
        let chunks = feed(&mut input, &mut chunker, &speech_like(&[(0.2, true)]));
        // Every 10 ms of speech still arrives; nothing is skipped.
        assert_eq!(chunks.len(), 20);
        assert_eq!(chunker.skipped(), 0);
    }

    #[test]
    fn soft_speech_is_transcribed_not_skipped() {
        let (mut input, mut chunker) = tap(16_000, 1, 2_000);
        chunker.cut_at_pauses(500);
        // Peaks around 0.008, below the level counted as sound.
        let soft: Vec<f32> = tone(SAMPLE_RATE as u32, 220.0, 4.0)
            .iter()
            .map(|x| x * 0.008)
            .collect();
        let chunks = feed(&mut input, &mut chunker, &soft);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunker.skipped(), 0);
    }

    #[test]
    fn pause_cuts_keep_session_times_exact() {
        let (mut input, mut chunker) = tap(48_000, 2, 3_000);
        chunker.cut_at_pauses(800);
        let mono = speech_like(&[
            (1.0, true),
            (0.5, false),
            (2.0, true),
            (0.5, false),
            (0.9, true),
        ]);
        // Upsample by repetition to 48 kHz stereo; timing must still match.
        let device: Vec<f32> = mono.iter().flat_map(|&x| [x; 6]).collect();
        let mut chunks = vec![];
        for block in device.chunks(9_600) {
            input.push_interleaved(block.iter().copied());
            chunks.extend(chunker.drain(5_000));
        }
        chunks.extend(chunker.finish(5_000));
        // One chunk per spoken part, each ending 200 ms into its pause; the
        // rest of each pause starts the next chunk.
        let spans: Vec<(u64, u64)> = chunks
            .iter()
            .map(|c| (c.start_ms, (c.samples.len() * 1_000 / SAMPLE_RATE) as u64))
            .collect();
        assert_eq!(spans, vec![(5_000, 1_200), (6_200, 2_500), (8_700, 1_200)]);
    }

    /// Runs only with the `local-whisper` feature and TALKQTE_WHISPER_MODEL
    /// plus TALKQTE_TAP_CLIP (a fictional 16-bit mono WAV at any rate): the
    /// clip goes through the tap, the resampler, and local Whisper.
    #[cfg(feature = "local-whisper")]
    #[test]
    fn resampled_speech_still_reaches_the_engine_as_a_question() {
        use crate::{
            engine::Engine,
            transcription::{whisper::LocalWhisper, Transcriber},
        };
        let (Some(model), Some(clip)) = (
            std::env::var_os("TALKQTE_WHISPER_MODEL"),
            std::env::var_os("TALKQTE_TAP_CLIP"),
        ) else {
            eprintln!("skipped: set TALKQTE_WHISPER_MODEL and TALKQTE_TAP_CLIP");
            return;
        };
        let bytes = std::fs::read(&clip).unwrap();
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let data = bytes.windows(4).position(|w| w == b"data").unwrap() + 8;
        let samples: Vec<f32> = bytes[data..]
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
            .collect();
        let (mut input, mut chunker) = tap(rate, 1, 5_000);
        // Feed it as a capture callback would: small blocks, drained as they arrive.
        let mut chunks = vec![];
        for block in samples.chunks(rate as usize / 10) {
            input.push_interleaved(block.iter().copied());
            chunks.extend(chunker.drain(0));
        }
        chunks.extend(chunker.finish(0));
        assert_eq!(chunker.overruns(), 0);
        let mut whisper = LocalWhisper::load(std::path::Path::new(&model), 4).unwrap();
        let mut engine = Engine::live();
        engine.start().unwrap();
        let mut lines = 0;
        for chunk in &chunks {
            // Advance the session clock to the end of this chunk, as a live
            // session would by the time the chunk is transcribed.
            let end = chunk.start_ms + chunk.samples.len() as u64 * 1_000 / SAMPLE_RATE as u64;
            engine.advance(end.saturating_sub(engine.state.elapsed_ms));
            for (n, line) in whisper.transcribe(chunk).unwrap().into_iter().enumerate() {
                let segment = crate::engine::Segment {
                    id: format!("tap-{}-{n}", chunk.start_ms),
                    at_ms: chunk.start_ms + line.offset_ms,
                    speaker: line.speaker,
                    text: line.text,
                };
                if engine.ingest(engine.session(), segment).is_ok() {
                    lines += 1;
                }
                if let Some(cue) = &engine.state.cue {
                    eprintln!(
                        "rate={rate} question raised after {lines} lines: {:?}",
                        cue.question
                    );
                    return;
                }
            }
        }
        panic!("no question raised from {lines} recognized lines at {rate} Hz");
    }
}
