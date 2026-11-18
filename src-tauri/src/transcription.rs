//! Transcription: captured audio becomes transcript segments only through a
//! cloud stream (`cloud`), opened once the session's review is approved.
//! Nothing here records or retains audio, and nothing is transcribed on this
//! device.

pub mod cloud;
#[cfg(feature = "cloud-transcription")]
pub mod deepgram;

/// 16 kHz mono samples, the format every capture path hands to transcription.
pub const SAMPLE_RATE: usize = 16_000;

/// Audio that starts at `start_ms` on the engine's session clock.
pub struct AudioChunk {
    pub start_ms: u64,
    pub samples: Vec<f32>,
}
