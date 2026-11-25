//! Lightweight, allocation-free local Voice Activity Detector (VAD) gate for
//! cloud speech-to-text streams.
//!
//! Runs on the transcription socket worker thread (never in a real-time audio
//! capture callback). Inspects 16 kHz mono PCM frames by RMS energy, buffers a
//! short pre-roll ring (`300 ms`) so speech onsets are not clipped, holds a
//! trailing hangover tail (`1400 ms`) after speech drops below threshold so
//! provider endpointing finalizes utterances cleanly, and suppresses PCM frames
//! beyond the hangover tail so dead air is not streamed or billed.

use super::SAMPLE_RATE;
use std::collections::VecDeque;
use std::fmt;

/// Analysis frame duration in milliseconds (20 ms at 16 kHz = 320 samples).
pub const FRAME_MS: usize = 20;
/// Samples per 20 ms VAD frame at 16 kHz mono.
pub const FRAME_SAMPLES: usize = SAMPLE_RATE * FRAME_MS / 1_000;
/// Pre-roll duration buffered before speech onset so opening consonants are preserved.
pub const PRE_ROLL_MS: usize = 300;
/// Number of 20 ms frames in the pre-roll ring buffer (15 frames = 300 ms).
pub const PRE_ROLL_FRAMES: usize = PRE_ROLL_MS / FRAME_MS;
/// Trailing hangover duration kept after speech energy drops below threshold so
/// natural pauses and Deepgram/ElevenLabs endpointing finalize utterances cleanly.
pub const HANGOVER_MS: usize = 1_400;
/// Number of 20 ms frames in the hangover tail (70 frames = 1400 ms).
pub const HANGOVER_FRAMES: usize = HANGOVER_MS / FRAME_MS;
/// Default frame RMS threshold (~ -42 dBFS) separating speech from quiet mic/room floor.
pub const DEFAULT_RMS_THRESHOLD: f32 = 0.008;

const SAMPLES_PER_MS: u64 = (SAMPLE_RATE / 1_000) as u64;
const MAX_TIMELINE_SPANS: usize = 16_384;

/// Configuration for [`VadGate`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VadConfig {
    pub rms_threshold: f32,
    pub pre_roll_frames: usize,
    pub hangover_frames: usize,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            rms_threshold: DEFAULT_RMS_THRESHOLD,
            pre_roll_frames: PRE_ROLL_FRAMES,
            hangover_frames: HANGOVER_FRAMES,
        }
    }
}

/// Current activity state of the VAD gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadState {
    /// Silent beyond hangover; PCM frames are suppressed and retained only in
    /// the bounded pre-roll ring.
    Silence,
    /// Active speech above the RMS threshold.
    Speech,
    /// Trailing silence after speech; PCM frames continue flowing until the
    /// hangover counter expires.
    Hangover,
}

#[derive(Clone, Copy)]
struct PreRollFrame {
    start_sample: u64,
    samples: [i16; FRAME_SAMPLES],
}

impl Default for PreRollFrame {
    fn default() -> Self {
        Self {
            start_sample: 0,
            samples: [0; FRAME_SAMPLES],
        }
    }
}

/// Allocation-free local VAD gate operating on 16 kHz mono `f32` PCM samples.
///
/// Emits quantized `i16` PCM slices along with their input sample offset via a
/// caller-supplied closure so zero heap allocations occur during audio gating.
pub struct VadGate {
    config: VadConfig,
    state: VadState,
    hangover_remaining: usize,
    accum: [f32; FRAME_SAMPLES],
    accum_len: usize,
    accum_start_sample: u64,
    total_input_samples: u64,
    emitted_samples: u64,
    suppressed_samples: u64,
    pre_roll: [PreRollFrame; PRE_ROLL_FRAMES],
    pre_roll_head: usize,
    pre_roll_len: usize,
}

impl fmt::Debug for VadGate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never include PCM audio buffers or sample values in Debug output.
        f.debug_struct("VadGate")
            .field("state", &self.state)
            .field("emitted_samples", &self.emitted_samples)
            .field("suppressed_samples", &self.suppressed_samples)
            .finish_non_exhaustive()
    }
}

impl Default for VadGate {
    fn default() -> Self {
        Self::new()
    }
}

impl VadGate {
    /// Creates a gate with default speech threshold, 300 ms pre-roll, and 1400 ms hangover.
    pub fn new() -> Self {
        Self::with_config(VadConfig::default())
    }

    /// Creates a gate with the given configuration (pre-roll clamped to `PRE_ROLL_FRAMES`).
    pub fn with_config(mut config: VadConfig) -> Self {
        config.pre_roll_frames = config.pre_roll_frames.min(PRE_ROLL_FRAMES);
        if !config.rms_threshold.is_finite() || config.rms_threshold < 0.0 {
            config.rms_threshold = DEFAULT_RMS_THRESHOLD;
        }
        Self {
            config,
            state: VadState::Silence,
            hangover_remaining: 0,
            accum: [0.0; FRAME_SAMPLES],
            accum_len: 0,
            accum_start_sample: 0,
            total_input_samples: 0,
            emitted_samples: 0,
            suppressed_samples: 0,
            pre_roll: [PreRollFrame::default(); PRE_ROLL_FRAMES],
            pre_roll_head: 0,
            pre_roll_len: 0,
        }
    }

    pub fn state(&self) -> VadState {
        self.state
    }

    pub fn emitted_samples(&self) -> u64 {
        self.emitted_samples
    }

    pub fn suppressed_samples(&self) -> u64 {
        self.suppressed_samples
    }

    /// Feeds 16 kHz mono `f32` samples through the gate, invoking `on_emit` with
    /// `(input_start_sample, pcm_i16)` for every active or pre-roll frame.
    pub fn push_samples(&mut self, mut samples: &[f32], mut on_emit: impl FnMut(u64, &[i16])) {
        if samples.is_empty() {
            return;
        }

        if self.accum_len > 0 {
            let need = FRAME_SAMPLES - self.accum_len;
            let take = need.min(samples.len());
            self.accum[self.accum_len..self.accum_len + take].copy_from_slice(&samples[..take]);
            self.accum_len += take;
            self.total_input_samples += take as u64;
            samples = &samples[take..];

            if self.accum_len == FRAME_SAMPLES {
                let frame = self.accum;
                let start = self.accum_start_sample;
                self.accum_len = 0;
                self.process_full_frame(&frame, start, &mut on_emit);
            }
        }

        while samples.len() >= FRAME_SAMPLES {
            let (head, rest) = samples.split_at(FRAME_SAMPLES);
            let start = self.total_input_samples;
            self.total_input_samples += FRAME_SAMPLES as u64;
            self.process_full_frame(head, start, &mut on_emit);
            samples = rest;
        }

        if !samples.is_empty() {
            self.accum_start_sample = self.total_input_samples;
            self.accum[..samples.len()].copy_from_slice(samples);
            self.accum_len = samples.len();
            self.total_input_samples += samples.len() as u64;
        }
    }

    /// Flushes any trailing sub-20 ms remainder when closing the stream.
    ///
    /// Emits the remainder if the gate is currently active/hangover or if the
    /// remainder itself crosses the speech RMS threshold; otherwise suppresses it.
    pub fn flush_end(&mut self, mut on_emit: impl FnMut(u64, &[i16])) {
        if self.accum_len == 0 {
            return;
        }
        let len = self.accum_len;
        let start = self.accum_start_sample;
        self.accum_len = 0;

        let mut i16_buf = [0i16; FRAME_SAMPLES];
        let rms = quantize_and_rms(&self.accum[..len], &mut i16_buf[..len]);
        let is_speech = rms >= self.config.rms_threshold;

        if self.state != VadState::Silence {
            self.emitted_samples += len as u64;
            on_emit(start, &i16_buf[..len]);
        } else if is_speech {
            self.flush_pre_roll(&mut on_emit);
            self.state = VadState::Speech;
            self.hangover_remaining = self.config.hangover_frames;
            self.emitted_samples += len as u64;
            on_emit(start, &i16_buf[..len]);
        } else {
            self.suppressed_samples += len as u64;
        }
    }

    fn process_full_frame(
        &mut self,
        frame: &[f32],
        start_sample: u64,
        on_emit: &mut impl FnMut(u64, &[i16]),
    ) {
        debug_assert_eq!(frame.len(), FRAME_SAMPLES);
        let mut i16_buf = [0i16; FRAME_SAMPLES];
        let rms = quantize_and_rms(frame, &mut i16_buf);
        let is_speech = rms >= self.config.rms_threshold;

        if is_speech {
            if self.state == VadState::Silence {
                self.flush_pre_roll(on_emit);
            }
            self.state = VadState::Speech;
            self.hangover_remaining = self.config.hangover_frames;
            self.emitted_samples += FRAME_SAMPLES as u64;
            on_emit(start_sample, &i16_buf);
            return;
        }

        match self.state {
            VadState::Speech | VadState::Hangover => {
                if self.hangover_remaining > 0 {
                    self.state = VadState::Hangover;
                    self.hangover_remaining -= 1;
                    self.emitted_samples += FRAME_SAMPLES as u64;
                    on_emit(start_sample, &i16_buf);
                } else {
                    self.state = VadState::Silence;
                    self.push_pre_roll(start_sample, &i16_buf);
                }
            }
            VadState::Silence => {
                self.push_pre_roll(start_sample, &i16_buf);
            }
        }
    }

    fn push_pre_roll(&mut self, start_sample: u64, samples: &[i16; FRAME_SAMPLES]) {
        self.suppressed_samples += FRAME_SAMPLES as u64;
        let cap = self.config.pre_roll_frames;
        if cap == 0 {
            return;
        }
        self.pre_roll[self.pre_roll_head] = PreRollFrame {
            start_sample,
            samples: *samples,
        };
        self.pre_roll_head = (self.pre_roll_head + 1) % cap;
        self.pre_roll_len = (self.pre_roll_len + 1).min(cap);
    }

    fn flush_pre_roll(&mut self, on_emit: &mut impl FnMut(u64, &[i16])) {
        let cap = self.config.pre_roll_frames;
        if cap == 0 || self.pre_roll_len == 0 {
            self.pre_roll_len = 0;
            self.pre_roll_head = 0;
            return;
        }
        let oldest = (self.pre_roll_head + cap - self.pre_roll_len) % cap;
        for i in 0..self.pre_roll_len {
            let idx = (oldest + i) % cap;
            let frame = &self.pre_roll[idx];
            // This frame was counted as suppressed while buffered in Silence;
            // adjust counts now that it is actually emitted.
            self.suppressed_samples = self.suppressed_samples.saturating_sub(FRAME_SAMPLES as u64);
            self.emitted_samples += FRAME_SAMPLES as u64;
            on_emit(frame.start_sample, &frame.samples);
        }
        self.pre_roll_len = 0;
        self.pre_roll_head = 0;
    }
}

/// Computes frame RMS energy while quantizing clamped `f32` samples to `i16`.
/// Non-finite inputs (`NaN`, `Inf`) are treated as `0.0`.
#[inline]
pub fn frame_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum_sq = 0.0f32;
    for &sample in samples {
        let clamped = sanitize(sample);
        sum_sq += clamped * clamped;
    }
    (sum_sq / samples.len() as f32).sqrt()
}

#[inline]
fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[inline]
fn quantize_and_rms(src: &[f32], dst: &mut [i16]) -> f32 {
    debug_assert_eq!(src.len(), dst.len());
    if src.is_empty() {
        return 0.0;
    }
    let mut sum_sq = 0.0f32;
    for (out, &sample) in dst.iter_mut().zip(src.iter()) {
        let clamped = sanitize(sample);
        sum_sq += clamped * clamped;
        *out = (clamped * i16::MAX as f32) as i16;
    }
    (sum_sq / src.len() as f32).sqrt()
}

#[derive(Clone, Copy)]
struct Span {
    sent_start: u64,
    len: u64,
    input_start: u64,
}

/// Maps timestamps on the provider's gated stream timeline back to the input
/// sample timeline expected by `CloudFeed::clock`, so skipping silent spans
/// never shifts transcript timestamps into the past.
#[derive(Default)]
pub(crate) struct StreamTimeline {
    spans: VecDeque<Span>,
    total_sent: u64,
}

impl StreamTimeline {
    pub(crate) fn record(&mut self, input_start: u64, len: u64) {
        if len == 0 {
            return;
        }
        let sent_start = self.total_sent;
        self.total_sent += len;
        if let Some(last) = self.spans.back_mut() {
            if last.input_start + last.len == input_start
                && last.sent_start + last.len == sent_start
            {
                last.len += len;
                return;
            }
        }
        if self.spans.len() == MAX_TIMELINE_SPANS {
            self.spans.pop_front();
        }
        self.spans.push_back(Span {
            sent_start,
            len,
            input_start,
        });
    }

    /// Converts a provider stream timestamp (ms) back into the input stream
    /// timestamp (ms) before VAD suppression.
    pub(crate) fn to_input_ms(&self, sent_ms: u64) -> u64 {
        if self.spans.is_empty() {
            return sent_ms;
        }
        let sent_sample = sent_ms.saturating_mul(SAMPLES_PER_MS);
        let index = self
            .spans
            .partition_point(|span| span.sent_start + span.len <= sent_sample);
        let Some(span) = self.spans.get(index) else {
            let last = self.spans.back().expect("non-empty spans");
            let end_sample = last.input_start + last.len.saturating_sub(1);
            return end_sample / SAMPLES_PER_MS;
        };
        let offset = sent_sample.saturating_sub(span.sent_start).min(span.len);
        (span.input_start + offset) / SAMPLES_PER_MS
    }

    pub(crate) fn remap_event(&self, event: super::cloud::SttEvent) -> super::cloud::SttEvent {
        match event {
            super::cloud::SttEvent::Final {
                seq,
                text,
                start_ms,
                end_ms,
                untrusted_speaker,
            } => {
                let mapped_start = self.to_input_ms(start_ms);
                let mapped_end = self.to_input_ms(end_ms).max(mapped_start);
                super::cloud::SttEvent::Final {
                    seq,
                    text,
                    start_ms: mapped_start,
                    end_ms: mapped_end,
                    untrusted_speaker,
                }
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine_wave(hz: f32, amplitude: f32, samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|n| amplitude * (2.0 * PI * hz * n as f32 / SAMPLE_RATE as f32).sin())
            .collect()
    }

    #[test]
    fn rms_energy_distinguishes_silence_from_synthetic_speech() {
        assert_eq!(frame_rms(&[]), 0.0);
        assert_eq!(frame_rms(&[0.0; FRAME_SAMPLES]), 0.0);
        assert_eq!(
            frame_rms(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY]),
            0.0
        );

        let noise = sine_wave(120.0, 0.002, FRAME_SAMPLES);
        assert!(frame_rms(&noise) < DEFAULT_RMS_THRESHOLD);

        let speech = sine_wave(440.0, 0.15, FRAME_SAMPLES);
        let rms = frame_rms(&speech);
        assert!((rms - 0.15 / std::f32::consts::SQRT_2).abs() < 0.005);
        assert!(rms >= DEFAULT_RMS_THRESHOLD);
    }

    #[test]
    fn pure_silence_suppresses_all_pcm_frames_and_allocates_nothing() {
        let mut emitted = Vec::new();
        let mut gate = None;

        // Both constructing VadGate and processing 5 s of silence + low floor noise
        // must make zero heap allocations.
        let allocs = crate::microphone::allocations_during(|| {
            let mut g = VadGate::new();
            let silence = [0.0f32; FRAME_SAMPLES];
            let noise = [0.002f32; FRAME_SAMPLES];
            for i in 0..250 {
                let chunk = if i % 2 == 0 { &silence } else { &noise };
                g.push_samples(chunk, |_, pcm| {
                    emitted.push(pcm.len());
                });
            }
            g.flush_end(|_, pcm| {
                emitted.push(pcm.len());
            });
            gate = Some(g);
        });

        let gate = gate.unwrap();
        assert_eq!(allocs, 0, "VadGate must be allocation-free");
        assert!(emitted.is_empty(), "pure silence must emit zero frames");
        assert_eq!(gate.state(), VadState::Silence);
        assert_eq!(gate.emitted_samples(), 0);
        assert_eq!(gate.suppressed_samples(), 250 * FRAME_SAMPLES as u64);
    }

    #[test]
    fn speech_onset_flushes_pre_roll_ring_without_clipping() {
        let mut gate = VadGate::new();
        let mut emitted: Vec<(u64, i16)> = Vec::new();

        // 700 ms of zero silence (should stay suppressed and out of pre-roll).
        let zero = vec![0.0f32; SAMPLE_RATE * 7 / 10];
        gate.push_samples(&zero, |start, pcm| {
            emitted.push((start, pcm[0]));
        });
        assert!(emitted.is_empty());

        // 300 ms of quiet sub-threshold pre-speech consonant breath (0.002 -> i16 = 65).
        let pre_roll = vec![0.002f32; SAMPLE_RATE * 3 / 10];
        gate.push_samples(&pre_roll, |start, pcm| {
            emitted.push((start, pcm[0]));
        });
        assert!(emitted.is_empty(), "still below threshold before speech");

        // 200 ms of synthetic sine speech starting at sample 16_000 (1,000 ms).
        let speech = sine_wave(440.0, 0.2, SAMPLE_RATE / 5);
        let mut emitted_samples = Vec::new();
        gate.push_samples(&speech, |start, pcm| {
            emitted.push((start, pcm[0]));
            emitted_samples.extend_from_slice(pcm);
        });

        assert_eq!(gate.state(), VadState::Speech);
        // 15 pre-roll frames (300 ms) + 10 speech frames (200 ms) = 25 frames = 500 ms.
        assert_eq!(emitted.len(), PRE_ROLL_FRAMES + 10);
        assert_eq!(
            emitted_samples.len(),
            (PRE_ROLL_FRAMES + 10) * FRAME_SAMPLES
        );
        // First emitted frame starts at 700 ms (sample 11_200), never 0 ms.
        assert_eq!(emitted[0].0, 11_200);
        // All 15 pre-roll frames carry the exact sub-threshold consonant value (65), in order.
        for (idx, &(start, sample)) in emitted[..PRE_ROLL_FRAMES].iter().enumerate() {
            assert_eq!(start, 11_200 + (idx * FRAME_SAMPLES) as u64);
            assert_eq!(sample, (0.002 * i16::MAX as f32) as i16);
        }
        // Speech frames start right at 1,000 ms (sample 16_000) without clipping.
        assert_eq!(emitted[PRE_ROLL_FRAMES].0, 16_000);
        assert_eq!(gate.emitted_samples(), emitted_samples.len() as u64);
        assert_eq!(gate.suppressed_samples(), 11_200);
    }

    #[test]
    fn hangover_tail_emits_clean_trailing_silence_then_gates() {
        let mut gate = VadGate::new();
        let mut frames_out = 0usize;

        // 400 ms of speech (20 frames).
        let speech = sine_wave(350.0, 0.2, SAMPLE_RATE * 2 / 5);
        gate.push_samples(&speech, |_, _| frames_out += 1);
        assert_eq!(frames_out, 20);
        assert_eq!(gate.state(), VadState::Speech);

        // 600 ms short natural pause (30 frames < 1,400 ms hangover): must stay open.
        let pause = vec![0.0f32; SAMPLE_RATE * 3 / 5];
        gate.push_samples(&pause, |_, _| frames_out += 1);
        assert_eq!(frames_out, 20 + 30);
        assert_eq!(gate.state(), VadState::Hangover);

        // Resume speech for 200 ms (10 frames): must NOT re-flush pre-roll (no duplicates).
        let speech2 = sine_wave(350.0, 0.2, SAMPLE_RATE / 5);
        gate.push_samples(&speech2, |_, _| frames_out += 1);
        assert_eq!(frames_out, 20 + 30 + 10);
        assert_eq!(gate.state(), VadState::Speech);

        // Now 3,000 ms of trailing silence (150 frames):
        // exactly HANGOVER_FRAMES (70 = 1,400 ms) are emitted, remaining 80 are gated.
        let trailing = vec![0.0f32; SAMPLE_RATE * 3];
        gate.push_samples(&trailing, |_, _| frames_out += 1);
        assert_eq!(gate.state(), VadState::Silence);
        assert_eq!(frames_out, 20 + 30 + 10 + HANGOVER_FRAMES);
        assert_eq!(
            gate.suppressed_samples(),
            ((150 - HANGOVER_FRAMES) * FRAME_SAMPLES) as u64
        );
        const {
            assert!(HANGOVER_MS >= 1_200 && HANGOVER_MS <= 1_500);
        }
    }

    #[test]
    fn arbitrary_chunk_sizes_and_flush_end_preserve_all_speech_samples() {
        let mut gate = VadGate::new();
        let speech = sine_wave(440.0, 0.2, 4_000);
        let mut out = Vec::new();

        // Feed in prime-sized blocks to exercise accumulator boundaries.
        for chunk in speech.chunks(137) {
            gate.push_samples(chunk, |_, pcm| out.extend_from_slice(pcm));
        }
        gate.flush_end(|_, pcm| out.extend_from_slice(pcm));
        assert_eq!(out.len(), 4_000);
        for (idx, (&src, &dst)) in speech.iter().zip(out.iter()).enumerate() {
            assert_eq!(
                dst,
                (src * i16::MAX as f32) as i16,
                "mismatch at sample {idx}"
            );
        }
    }

    #[test]
    fn stream_timeline_maps_provider_timestamps_across_suppressed_silence_gaps() {
        let mut timeline = StreamTimeline::default();
        // Empty timeline passes timestamps through unchanged.
        assert_eq!(timeline.to_input_ms(2_000), 2_000);

        // Utterance 1: 29.7s silence suppressed; 300ms pre-roll + 2s speech + 1.4s hangover sent
        // starting at input sample 29_700 * 16 = 475_200 (length 3.7s = 59_200 samples).
        for i in 0..185 {
            timeline.record(475_200 + i * 320, 320);
        }
        assert_eq!(timeline.spans.len(), 1, "contiguous spans coalesce");

        // 10s silence gap suppressed; Utterance 2 starts at input sample 43_700 * 16 = 699_200.
        timeline.record(699_200, 32_000);
        assert_eq!(timeline.spans.len(), 2);

        // Provider time 300 ms (onset of utterance 1 speech) -> input 30_000 ms.
        assert_eq!(timeline.to_input_ms(300), 30_000);
        // Provider time 3_700 ms (start of utterance 2) -> input 43_700 ms.
        assert_eq!(timeline.to_input_ms(3_700), 43_700);
        // Provider time 4_200 ms (500 ms into utterance 2) -> input 44_200 ms.
        assert_eq!(timeline.to_input_ms(4_200), 44_200);
        // Clamped safely at the very end so StreamClock never rejects boundary rounding.
        assert_eq!(timeline.to_input_ms(5_700), 45_699);
    }

    #[test]
    #[ignore = "run in a child process by the isolation test below"]
    fn isolated_vad_gate_run() {
        let mut gate = VadGate::new();
        let silence = vec![0.0f32; SAMPLE_RATE * 2];
        let speech = sine_wave(440.0, 0.25, SAMPLE_RATE);
        gate.push_samples(&silence, |_, _| {});
        gate.push_samples(&speech, |_, _| {});
        gate.push_samples(&silence, |_, _| {});
        gate.flush_end(|_, _| {});
        let _ = format!("{gate:?}");
    }

    #[test]
    fn vad_debug_and_execution_leak_or_log_no_audio_bytes() {
        let mut gate = VadGate::new();
        let speech = sine_wave(440.0, 0.25, SAMPLE_RATE / 10);
        gate.push_samples(&speech, |_, _| {});
        let debug = format!("{gate:?}");
        assert!(debug.contains("VadGate"));
        assert!(!debug.contains("accum"));
        assert!(!debug.contains("pre_roll"));
        // Verify specific sample value never appears in Debug output.
        let sample_val = ((speech[1] * i16::MAX as f32) as i16).to_string();
        assert!(!debug.contains(&sample_val), "{debug}");

        let crate::test_isolation::Isolated { left, printed } = crate::test_isolation::run(
            "transcription::vad::tests::isolated_vad_gate_run",
            &[],
            &[],
        );
        assert!(left.is_empty(), "VAD wrote files: {left:?}");
        assert!(!printed.contains(&sample_val), "{printed}");
        assert!(!printed.contains("VadGate"), "{printed}");
        let non_harness_lines: Vec<&str> = printed
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with("running ")
                    && !line.starts_with("test ")
                    && !line.starts_with("test result:")
            })
            .collect();
        assert!(
            non_harness_lines.is_empty(),
            "VAD printed unexpected output: {non_harness_lines:?}"
        );
    }
}
