//! Audio tap: carries microphone samples from the real-time capture callback
//! to a transcription chunker without allocating, locking, or blocking in
//! the callback. The callback side downmixes to mono and pushes into a
//! fixed-size lock-free ring; when the ring is full, samples are dropped and
//! counted. The chunker side, on its own thread, resamples to 16 kHz and
//! produces fixed-length chunks on the session clock. Nothing is written to
//! disk or kept after a chunk is handed on.

use crate::transcription::{AudioChunk, SAMPLE_RATE};
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

/// Seconds of device audio the ring can hold before samples are dropped.
pub const RING_SECONDS: usize = 4;

/// Shared counter of samples dropped because the ring was full.
#[derive(Default)]
pub struct Overruns(AtomicU64);

impl Overruns {
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
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
        },
        Chunker {
            consumer,
            resampler: Resampler::new(device_rate),
            pending: Vec::with_capacity(SAMPLE_RATE * chunk_ms as usize / 1_000),
            chunk_samples: (SAMPLE_RATE as u64 * chunk_ms / 1_000).max(1) as usize,
            emitted: 0,
            overruns,
        },
    )
}

/// The callback side. Every method is allocation-free and wait-free.
pub struct TapInput {
    producer: Producer<f32>,
    channels: usize,
    overruns: Arc<Overruns>,
}

impl TapInput {
    /// Downmixes interleaved samples to mono and queues them. Samples that do
    /// not fit are dropped and counted, never waited for.
    pub fn push_interleaved(&mut self, samples: impl Iterator<Item = f32>) {
        let mut sum = 0.0;
        let mut in_frame = 0;
        for sample in samples {
            sum += if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            in_frame += 1;
            if in_frame == self.channels {
                if self.producer.push(sum / self.channels as f32).is_err() {
                    self.overruns.0.fetch_add(1, Ordering::Relaxed);
                }
                sum = 0.0;
                in_frame = 0;
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
    /// 16 kHz samples already emitted, which sets each chunk's start time.
    emitted: u64,
    overruns: Arc<Overruns>,
}

impl Chunker {
    /// Moves everything queued so far through the resampler and returns any
    /// complete chunks. `session_start_ms` is the session time at which the
    /// tap started, so chunk times line up with the engine's clock.
    pub fn drain(&mut self, session_start_ms: u64) -> Vec<AudioChunk> {
        while let Ok(sample) = self.consumer.pop() {
            self.resampler.push(sample, &mut self.pending);
        }
        let mut chunks = vec![];
        while self.pending.len() >= self.chunk_samples {
            let rest = self.pending.split_off(self.chunk_samples);
            let samples = std::mem::replace(&mut self.pending, rest);
            chunks.push(self.chunk(session_start_ms, samples));
        }
        chunks
    }

    /// Returns the final partial chunk, if any, when capture stops.
    pub fn finish(&mut self, session_start_ms: u64) -> Option<AudioChunk> {
        let mut chunks = self.drain(session_start_ms);
        let partial = std::mem::take(&mut self.pending);
        chunks.extend((!partial.is_empty()).then(|| self.chunk(session_start_ms, partial)));
        chunks.into_iter().last()
    }

    pub fn overruns(&self) -> u64 {
        self.overruns.get()
    }

    fn chunk(&mut self, session_start_ms: u64, samples: Vec<f32>) -> AudioChunk {
        let start_ms = session_start_ms + self.emitted * 1_000 / SAMPLE_RATE as u64;
        self.emitted += samples.len() as u64;
        AudioChunk { start_ms, samples }
    }
}

/// Converts mono audio at the device rate to 16 kHz. Each output sample
/// averages the input samples that fall within its period (a box filter,
/// which reduces aliasing when downsampling), and upsampling interpolates
/// linearly. Adequate for speech recognition; not a high-fidelity resampler.
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
    fn invalid_samples_are_silenced_and_loud_ones_clipped() {
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        let mut samples = vec![f32::NAN, f32::INFINITY, 4.0, -4.0];
        samples.resize(16_000, 0.0);
        input.push_interleaved(samples.into_iter());
        let chunk = &chunker.drain(0)[0];
        assert_eq!(&chunk.samples[..4], &[0.0, 0.0, 1.0, -1.0]);
    }

    #[test]
    fn finish_returns_the_last_partial_chunk_once() {
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        input.push_interleaved(std::iter::repeat_n(0.0, 24_000));
        assert_eq!(chunker.drain(0).len(), 1);
        let last = chunker.finish(0).expect("half a second remains");
        assert_eq!((last.start_ms, last.samples.len()), (1_000, 8_000));
        assert!(chunker.finish(0).is_none());
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
