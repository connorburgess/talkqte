//! Live session runner: moves audio from the capture tap's `Chunker` to the
//! transcription `Worker` on a background thread, and stops both in order.
//! It knows nothing about Tauri, so the session lifecycle can be tested with
//! synthetic audio and a scripted recognizer. Nothing here records or keeps
//! audio; chunks go straight to the worker and are dropped after use.

use crate::{
    audio_tap::Chunker,
    engine::Segment,
    transcription::{Stats, Transcriber, Worker},
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::Duration,
};

/// How often the runner moves queued audio to the worker.
pub const DRAIN_EVERY: Duration = Duration::from_millis(250);
/// Chunks waiting for the recognizer before new audio is dropped.
pub const WORKER_QUEUE: usize = 4;
/// How long a normal stop waits for queued audio to be transcribed.
pub const FINISH_WAIT: Duration = Duration::from_secs(10);

/// What the runner saw, for diagnostics and tests. Contains no audio or text.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub worker: Stats,
    /// Device samples dropped because the tap's ring was full.
    pub tap_overruns: u64,
    /// Chunks refused by the worker's queue.
    pub refused_chunks: u64,
}

pub struct LiveSession {
    stop: Arc<AtomicBool>,
    refused: Arc<AtomicU64>,
    thread: Option<JoinHandle<(Chunker, Worker)>>,
    session_start_ms: u64,
}

impl LiveSession {
    /// Starts moving audio from `chunker` to a worker running `transcriber`.
    /// `session` and `session_start_ms` come from the engine when capture
    /// starts, so segment times line up with its clock. `sink` delivers each
    /// recognized line, normally into `Engine::ingest`.
    pub fn start<T, S>(
        mut chunker: Chunker,
        session: u64,
        session_start_ms: u64,
        transcriber: T,
        sink: S,
    ) -> Self
    where
        T: Transcriber,
        S: FnMut(u64, Segment) -> Result<(), String> + Send + 'static,
    {
        let worker = Worker::start(session, WORKER_QUEUE, transcriber, sink);
        let stop = Arc::new(AtomicBool::new(false));
        let refused = Arc::new(AtomicU64::new(0));
        let (flag, count) = (stop.clone(), refused.clone());
        let thread = std::thread::Builder::new()
            .name("talkqte-live-session".into())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    for chunk in chunker.drain(session_start_ms) {
                        if worker.submit(chunk).is_err() {
                            count.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    std::thread::sleep(DRAIN_EVERY);
                }
                (chunker, worker)
            })
            .expect("live session thread starts");
        Self {
            stop,
            refused,
            thread: Some(thread),
            session_start_ms,
        }
    }

    /// Stops after capture has stopped: hands the remaining audio to the
    /// worker, then stops the worker. Call without holding the engine lock,
    /// because delivering lines takes it.
    pub fn stop(mut self) -> Report {
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Report::default();
        };
        let Ok((mut chunker, worker)) = thread.join() else {
            return Report::default();
        };
        for chunk in chunker.finish(self.session_start_ms) {
            if worker.submit(chunk).is_err() {
                self.refused.fetch_add(1, Ordering::Relaxed);
            }
        }
        Report {
            tap_overruns: chunker.overruns(),
            refused_chunks: self.refused.load(Ordering::Relaxed),
            worker: worker.finish(FINISH_WAIT),
        }
    }

    /// Stops at once for End: queued audio and results in progress are
    /// discarded, and nothing more reaches the engine.
    pub fn end(mut self) -> Report {
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Report::default();
        };
        let Ok((chunker, worker)) = thread.join() else {
            return Report::default();
        };
        worker.cancel();
        Report {
            tap_overruns: chunker.overruns(),
            refused_chunks: self.refused.load(Ordering::Relaxed),
            worker: worker.stop(),
        }
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            if let Ok((_, worker)) = thread.join() {
                worker.cancel();
                worker.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audio_tap::tap,
        engine::Engine,
        transcription::{AudioChunk, Recognized, SAMPLE_RATE},
    };
    use std::sync::{mpsc, Mutex};

    /// Recognizes a loud chunk as one fixed line; silence as nothing.
    struct Loudness(&'static str);

    impl Transcriber for Loudness {
        fn transcribe(&mut self, chunk: &AudioChunk) -> Result<Vec<Recognized>, String> {
            let loud = chunk.samples.iter().any(|sample| sample.abs() > 0.1);
            Ok(if loud {
                vec![Recognized {
                    offset_ms: 0,
                    speaker: "Speaker".into(),
                    text: self.0.into(),
                }]
            } else {
                vec![]
            })
        }
    }

    fn live_engine() -> Arc<Mutex<Engine>> {
        let mut engine = Engine::live();
        engine.start().unwrap();
        Arc::new(Mutex::new(engine))
    }

    fn sink(
        engine: &Arc<Mutex<Engine>>,
    ) -> (
        impl FnMut(u64, Segment) -> Result<(), String>,
        mpsc::Receiver<bool>,
    ) {
        let engine = engine.clone();
        let (report, outcomes) = mpsc::channel();
        (
            move |session, segment| {
                let mut engine = engine.lock().unwrap();
                // Keep the engine clock at least as far as the line.
                let behind = segment.at_ms.saturating_sub(engine.state.elapsed_ms);
                engine.advance(behind);
                let result = engine.ingest(session, segment);
                let _ = report.send(result.is_ok());
                result
            },
            outcomes,
        )
    }

    #[test]
    fn captured_speech_becomes_a_sourced_question_and_stop_flushes_the_rest() {
        let engine = live_engine();
        let session = engine.lock().unwrap().session();
        let (mut input, chunker) = tap(16_000, 1, 1_000);
        let (sink, outcomes) = sink(&engine);
        let live = LiveSession::start(
            chunker,
            session,
            0,
            Loudness("Someone can take the first draft."),
            sink,
        );
        // One second of "speech", then half a second that only stop delivers.
        input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE));
        assert!(outcomes.recv_timeout(Duration::from_secs(5)).unwrap());
        assert_eq!(
            engine.lock().unwrap().state.cue.as_ref().unwrap().kind,
            "Owner"
        );
        input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE / 2));
        let report = live.stop();
        assert_eq!(
            report.worker.chunks, 2,
            "the final half second is transcribed too"
        );
        assert_eq!((report.tap_overruns, report.refused_chunks), (0, 0));
    }

    #[test]
    fn silence_produces_no_lines() {
        let engine = live_engine();
        let session = engine.lock().unwrap().session();
        let (mut input, chunker) = tap(48_000, 2, 1_000);
        let (sink, _) = sink(&engine);
        let live = LiveSession::start(chunker, session, 0, Loudness("unused"), sink);
        input.push_interleaved(std::iter::repeat_n(0.0, 48_000 * 2 * 2));
        std::thread::sleep(DRAIN_EVERY * 3);
        let report = live.stop();
        assert_eq!(report.worker.accepted, 0);
        assert!(engine.lock().unwrap().state.transcript.is_empty());
    }

    #[test]
    fn end_discards_queued_audio_and_nothing_more_reaches_the_engine() {
        let engine = live_engine();
        let session = engine.lock().unwrap().session();
        let (mut input, chunker) = tap(16_000, 1, 1_000);
        let (sink, _) = sink(&engine);
        let live = LiveSession::start(chunker, session, 0, Loudness("Someone can take it."), sink);
        engine.lock().unwrap().end();
        input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE * 3));
        let report = live.end();
        assert_eq!(report.worker.accepted, 0);
        assert!(engine.lock().unwrap().state.transcript.is_empty());
    }

    #[test]
    fn dropping_a_session_stops_its_threads() {
        let engine = live_engine();
        let session = engine.lock().unwrap().session();
        let (_input, chunker) = tap(16_000, 1, 1_000);
        let (sink, _) = sink(&engine);
        let live = LiveSession::start(chunker, session, 0, Loudness("unused"), sink);
        drop(live); // must return rather than hang
    }
}
