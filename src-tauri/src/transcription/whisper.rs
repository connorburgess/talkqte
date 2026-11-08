//! Local Whisper recognizer, built only with the `local-whisper` feature.
//! whisper.cpp runs in-process on the transcription worker thread. It reads
//! the model file it is given and nothing else: no downloads, no network,
//! and no audio written to disk. Model delivery is a separate decision.

use super::{AudioChunk, Recognized, Transcriber, SAMPLE_RATE};
use std::{path::Path, sync::Once};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

/// Whisper does not separate speakers, so every line gets this label.
pub const UNKNOWN_SPEAKER: &str = "Speaker";

pub struct LocalWhisper {
    state: WhisperState,
    threads: i32,
}

impl LocalWhisper {
    /// Loads a GGML Whisper model. Fails, rather than downloading anything,
    /// when the file is missing or unreadable.
    pub fn load(model: &Path, threads: usize) -> Result<Self, String> {
        // Route whisper.cpp's own logging away from stderr.
        static QUIET: Once = Once::new();
        QUIET.call_once(whisper_rs::install_logging_hooks);
        if !model.is_file() {
            return Err("The speech model file was not found.".into());
        }
        let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
            .map_err(|_| "The speech model could not be loaded.".to_string())?;
        let state = context
            .create_state()
            .map_err(|_| "The speech model could not be prepared.".to_string())?;
        Ok(Self {
            state,
            threads: threads.clamp(1, 8) as i32,
        })
    }
}

impl Transcriber for LocalWhisper {
    fn transcribe(&mut self, chunk: &AudioChunk) -> Result<Vec<Recognized>, String> {
        // Whisper needs at least a second of audio; pad short chunks with silence.
        let mut padded;
        let samples = if chunk.samples.len() < SAMPLE_RATE {
            padded = chunk.samples.clone();
            padded.resize(SAMPLE_RATE, 0.0);
            &padded[..]
        } else {
            &chunk.samples[..]
        };
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_n_threads(self.threads);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        self.state
            .full(params, samples)
            .map_err(|_| "Speech recognition failed for this audio.".to_string())?;
        Ok(self
            .state
            .as_iter()
            .filter_map(|segment| {
                let text = segment.to_str_lossy().ok()?.trim().to_string();
                // Skip empty lines and markers such as "[BLANK_AUDIO]".
                let marker = (text.starts_with('[') && text.ends_with(']'))
                    || (text.starts_with('(') && text.ends_with(')'));
                if text.is_empty() || marker {
                    return None;
                }
                Some(Recognized {
                    offset_ms: segment.start_timestamp().max(0) as u64 * 10,
                    speaker: UNKNOWN_SPEAKER.into(),
                    text,
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::Engine,
        transcription::{Stats, Worker},
    };
    use std::sync::{Arc, Mutex};

    /// Reads a 16-bit PCM, 16 kHz mono WAV file.
    fn read_wav(path: &Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("readable clip");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let mut at = 12;
        let mut format_ok = false;
        while at + 8 <= bytes.len() {
            let id = &bytes[at..at + 4];
            let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
            if id == b"fmt " {
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let bits = u16::from_le_bytes([body[14], body[15]]);
                assert_eq!(
                    (channels, rate, bits),
                    (1, SAMPLE_RATE as u32, 16),
                    "16 kHz mono 16-bit PCM"
                );
                format_ok = true;
            } else if id == b"data" {
                assert!(format_ok);
                return body
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
                    .collect();
            }
            at += 8 + size + (size & 1);
        }
        panic!("no audio data in clip");
    }

    /// Runs only when TALKQTE_WHISPER_MODEL and TALKQTE_WHISPER_CLIP point to
    /// a local model and a fictional synthetic clip; otherwise it is skipped.
    #[test]
    fn a_synthetic_clip_is_transcribed_locally_into_a_sourced_question() {
        let (Some(model), Some(clip)) = (
            std::env::var_os("TALKQTE_WHISPER_MODEL"),
            std::env::var_os("TALKQTE_WHISPER_CLIP"),
        ) else {
            eprintln!("skipped: set TALKQTE_WHISPER_MODEL and TALKQTE_WHISPER_CLIP");
            return;
        };
        let samples = read_wav(Path::new(&clip));
        assert!(samples.len() <= SAMPLE_RATE * crate::transcription::MAX_CHUNK_SECONDS);
        let whisper = LocalWhisper::load(Path::new(&model), 4).expect("model loads");

        let mut engine = Engine::live();
        engine.start().unwrap();
        engine.advance(1_000 + samples.len() as u64 * 1_000 / SAMPLE_RATE as u64);
        let engine = Arc::new(Mutex::new(engine));
        let session = engine.lock().unwrap().session();
        let sink_engine = engine.clone();
        let (report, outcomes) = std::sync::mpsc::channel();
        let worker = Worker::start(session, 2, whisper, move |session, segment| {
            let result = sink_engine.lock().unwrap().ingest(session, segment);
            let _ = report.send(result.is_ok());
            result
        });
        let started = std::time::Instant::now();
        assert!(worker
            .submit(AudioChunk {
                start_ms: 0,
                samples
            })
            .is_ok());
        assert!(outcomes
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("a line within 60 s"));
        let first_line = started.elapsed();
        while outcomes
            .recv_timeout(std::time::Duration::from_secs(2))
            .is_ok()
        {}
        let stats: Stats = worker.stop();
        let engine = engine.lock().unwrap();
        let recognized: Vec<_> = engine
            .state
            .transcript
            .iter()
            .filter(|s| s.id.starts_with('t'))
            .collect();
        let cue = engine
            .state
            .cue
            .as_ref()
            .expect("the owner line raises a question");
        eprintln!(
            "lines={} first_line_ms={} stats={stats:?} cue={:?} source={}",
            recognized.len(),
            first_line.as_millis(),
            cue.question,
            cue.source_id
        );
        assert_eq!(cue.kind, "Owner");
        assert!(recognized.iter().any(|s| s.id == cue.source_id));
        assert!(recognized.iter().all(|s| s.speaker == UNKNOWN_SPEAKER));
        assert_eq!((stats.failures, stats.detached), (0, false));
    }
}
