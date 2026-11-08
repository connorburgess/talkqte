//! Transcription worker: turns queued audio chunks into transcript segments
//! for one session, off the audio callback. The capture side only hands over
//! a chunk with `submit`, which never blocks; inference, parsing, and engine
//! updates happen on the worker thread. Nothing here records or retains
//! audio, and no recognizer is connected to the app yet.

use crate::engine::Segment;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread::JoinHandle,
};

/// 16 kHz mono samples, the input format local Whisper models expect.
pub const SAMPLE_RATE: usize = 16_000;
/// Longest chunk accepted, so one call cannot hold the worker for long.
pub const MAX_CHUNK_SECONDS: usize = 30;

/// Audio that starts at `start_ms` on the engine's session clock.
pub struct AudioChunk {
    pub start_ms: u64,
    pub samples: Vec<f32>,
}

/// Text recognized within a chunk, offset from the chunk's start.
pub struct Recognized {
    pub offset_ms: u64,
    pub speaker: String,
    pub text: String,
}

/// A replaceable speech recognizer. Implementations run on the worker
/// thread only and must not open the network or keep audio.
pub trait Transcriber: Send + 'static {
    fn transcribe(&mut self, chunk: &AudioChunk) -> Result<Vec<Recognized>, String>;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Chunks the recognizer processed.
    pub chunks: u64,
    /// Segments the engine accepted.
    pub accepted: u64,
    /// Segments the engine refused, for example after the session ended.
    pub rejected: u64,
    /// Chunks refused at submit because the queue was full, the worker had
    /// stopped, or the chunk was too long.
    pub dropped: u64,
    /// Recognizer errors; the worker continues with the next chunk.
    pub failures: u64,
}

pub struct Worker {
    sender: Option<SyncSender<AudioChunk>>,
    cancelled: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    thread: Option<JoinHandle<Stats>>,
}

impl Worker {
    /// Starts a worker for `session` (from `Engine::session()`) with room for
    /// `capacity` waiting chunks. `sink` delivers each segment, normally by
    /// locking the engine and calling `Engine::ingest`.
    pub fn start<T, S>(session: u64, capacity: usize, transcriber: T, sink: S) -> Self
    where
        T: Transcriber,
        S: FnMut(u64, Segment) -> Result<(), String> + Send + 'static,
    {
        let (sender, receiver) = sync_channel(capacity.max(1));
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let thread = std::thread::Builder::new()
            .name("talkqte-transcription".into())
            .spawn(move || run(session, receiver, flag, transcriber, sink))
            .expect("transcription worker thread starts");
        Self {
            sender: Some(sender),
            cancelled,
            dropped: Arc::new(AtomicU64::new(0)),
            thread: Some(thread),
        }
    }

    /// Queues a chunk without blocking. Returns false, and counts the chunk
    /// as dropped, when the queue is full, the worker is stopping, or the
    /// chunk is longer than `MAX_CHUNK_SECONDS`. Dropped audio is not
    /// retried; the transcript simply has a gap.
    pub fn submit(&self, chunk: AudioChunk) -> bool {
        let fits = chunk.samples.len() <= SAMPLE_RATE * MAX_CHUNK_SECONDS;
        let sent = fits
            && !self.cancelled.load(Ordering::Acquire)
            && self.sender.as_ref().is_some_and(|sender| {
                !matches!(
                    sender.try_send(chunk),
                    Err(TrySendError::Full(_) | TrySendError::Disconnected(_))
                )
            });
        if !sent {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        sent
    }

    /// Stops the worker: queued chunks are discarded, a recognizer call in
    /// progress finishes, and its results are not delivered.
    pub fn stop(mut self) -> Stats {
        self.shutdown()
    }

    fn shutdown(&mut self) -> Stats {
        self.cancelled.store(true, Ordering::Release);
        self.sender.take();
        let mut stats = self
            .thread
            .take()
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        stats.dropped = self.dropped.load(Ordering::Relaxed);
        stats
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.shutdown();
        }
    }
}

fn run<T: Transcriber, S: FnMut(u64, Segment) -> Result<(), String>>(
    session: u64,
    receiver: Receiver<AudioChunk>,
    cancelled: Arc<AtomicBool>,
    mut transcriber: T,
    mut sink: S,
) -> Stats {
    let mut stats = Stats::default();
    let mut next_id = 0u64;
    while let Ok(chunk) = receiver.recv() {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let recognized = transcriber.transcribe(&chunk);
        stats.chunks += 1;
        // A stop during inference discards that chunk's results.
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        match recognized {
            Ok(items) => {
                for item in items {
                    let segment = Segment {
                        id: format!("t{session}-{next_id}"),
                        at_ms: chunk.start_ms.saturating_add(item.offset_ms),
                        speaker: item.speaker,
                        text: item.text,
                    };
                    next_id += 1;
                    match sink(session, segment) {
                        Ok(()) => stats.accepted += 1,
                        Err(_) => stats.rejected += 1,
                    }
                }
            }
            Err(_) => stats.failures += 1,
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use std::sync::{mpsc, Mutex};

    /// Returns scripted lines, one call per chunk, after an optional gate.
    struct Script {
        lines: Vec<Result<Vec<&'static str>, &'static str>>,
        gate: Option<mpsc::Receiver<()>>,
        calls: Arc<AtomicU64>,
    }

    impl Transcriber for Script {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            if let Some(gate) = &self.gate {
                let _ = gate.recv();
            }
            let index = self.calls.fetch_add(1, Ordering::SeqCst) as usize;
            match self.lines.get(index).cloned().unwrap_or(Ok(vec![])) {
                Ok(lines) => Ok(lines
                    .into_iter()
                    .enumerate()
                    .map(|(n, text)| Recognized {
                        offset_ms: n as u64 * 500,
                        speaker: "Speaker 1".into(),
                        text: text.into(),
                    })
                    .collect()),
                Err(message) => Err(message.into()),
            }
        }
    }

    // At 66 s the bundled demo has no open question and its cooldown has
    // passed, so a recognized trigger raises a question.
    fn running_engine() -> Arc<Mutex<Engine>> {
        let mut engine = Engine::default();
        engine.start().unwrap();
        engine.advance(66_000);
        Arc::new(Mutex::new(engine))
    }

    /// Delivers into the engine and reports each outcome to the test.
    fn into_engine(
        engine: &Arc<Mutex<Engine>>,
    ) -> (
        impl FnMut(u64, Segment) -> Result<(), String>,
        mpsc::Receiver<bool>,
    ) {
        let engine = engine.clone();
        let (report, outcomes) = mpsc::channel();
        let sink = move |session, segment| {
            let result = engine.lock().unwrap().ingest(session, segment);
            let _ = report.send(result.is_ok());
            result
        };
        (sink, outcomes)
    }

    fn chunk(start_ms: u64) -> AudioChunk {
        AudioChunk {
            start_ms,
            samples: vec![0.0; SAMPLE_RATE],
        }
    }

    fn script(lines: Vec<Result<Vec<&'static str>, &'static str>>) -> Script {
        Script {
            lines,
            gate: None,
            calls: Arc::new(AtomicU64::new(0)),
        }
    }

    #[test]
    fn recognized_speech_raises_a_sourced_question_and_its_answer_withdraws_it() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (sink, outcomes) = into_engine(&engine);
        let lines = vec![
            Ok(vec!["Someone can take the first draft."]),
            Ok(vec!["Jordan will take it."]),
        ];
        let worker = Worker::start(session, 4, script(lines), sink);
        assert!(worker.submit(chunk(64_000)));
        assert!(outcomes.recv().unwrap());
        {
            let engine = engine.lock().unwrap();
            let cue = engine
                .state
                .cue
                .as_ref()
                .expect("a question from recognized speech");
            assert_eq!(cue.source_id, format!("t{session}-0"));
            assert_eq!(engine.state.transcript.last().unwrap().at_ms, 64_000);
        }
        assert!(worker.submit(chunk(65_000)));
        assert!(outcomes.recv().unwrap());
        assert!(
            engine.lock().unwrap().state.cue.is_none(),
            "answered question withdrawn"
        );
        let stats = worker.stop();
        assert_eq!(
            stats,
            Stats {
                chunks: 2,
                accepted: 2,
                ..Stats::default()
            }
        );
    }

    #[test]
    fn a_full_queue_drops_audio_instead_of_blocking_the_caller() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (open, gate) = mpsc::channel();
        let script = Script {
            lines: vec![],
            gate: Some(gate),
            calls: Arc::new(AtomicU64::new(0)),
        };
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(session, 2, script, sink);
        let accepted = (0..6)
            .filter(|n| worker.submit(chunk(60_000 + n * 1_000)))
            .count();
        // One chunk may be inside the recognizer and two waiting; the rest drop.
        assert!((2..=3).contains(&accepted), "accepted {accepted}");
        for _ in 0..6 {
            let _ = open.send(());
        }
        let stats = worker.stop();
        assert_eq!(stats.dropped, 6 - accepted as u64);
    }

    #[test]
    fn oversized_chunks_are_refused() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(session, 2, script(vec![]), sink);
        let samples = vec![0.0; SAMPLE_RATE * MAX_CHUNK_SECONDS + 1];
        assert!(!worker.submit(AudioChunk {
            start_ms: 60_000,
            samples
        }));
        assert_eq!(worker.stop().dropped, 1);
    }

    #[test]
    fn ending_the_session_rejects_late_results_without_changing_the_transcript() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (open, gate) = mpsc::channel();
        let script = Script {
            lines: vec![Ok(vec!["Someone can take the first draft."])],
            gate: Some(gate),
            calls: Arc::new(AtomicU64::new(0)),
        };
        let (sink, outcomes) = into_engine(&engine);
        let worker = Worker::start(session, 2, script, sink);
        assert!(worker.submit(chunk(64_000)));
        let before = engine.lock().unwrap().state.transcript.len();
        engine.lock().unwrap().end(); // End while the recognizer is busy.
        open.send(()).unwrap();
        assert!(
            !outcomes.recv().unwrap(),
            "the ended session refuses the late segment"
        );
        let stats = worker.stop();
        let engine = engine.lock().unwrap();
        assert_eq!(engine.state.transcript.len(), before);
        assert!(engine.state.cue.is_none());
        assert_eq!((stats.accepted, stats.rejected), (0, 1));
    }

    #[test]
    fn stopping_discards_queued_audio_and_results_in_progress() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (open, gate) = mpsc::channel();
        let calls = Arc::new(AtomicU64::new(0));
        let script = Script {
            lines: vec![Ok(vec!["Hello."]), Ok(vec!["Again."]), Ok(vec!["More."])],
            gate: Some(gate),
            calls: calls.clone(),
        };
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(session, 4, script, sink);
        for n in 0..3 {
            assert!(worker.submit(chunk(60_000 + n * 1_000)));
        }
        let before = engine.lock().unwrap().state.transcript.len();
        // Release the first recognizer call only after stop has begun.
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let _ = open.send(());
        });
        let stats = worker.stop();
        release.join().unwrap();
        assert_eq!(stats.accepted, 0, "nothing delivered after stop");
        assert!(calls.load(Ordering::SeqCst) <= 1, "queued chunks discarded");
        assert_eq!(engine.lock().unwrap().state.transcript.len(), before);
    }

    #[test]
    fn a_recognizer_error_skips_one_chunk_and_the_worker_continues() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (sink, outcomes) = into_engine(&engine);
        let worker = Worker::start(
            session,
            4,
            script(vec![Err("model unavailable"), Ok(vec!["Hello."])]),
            sink,
        );
        assert!(worker.submit(chunk(60_000)));
        assert!(worker.submit(chunk(61_000)));
        assert!(outcomes.recv().unwrap());
        let stats = worker.stop();
        assert_eq!((stats.chunks, stats.failures, stats.accepted), (2, 1, 1));
    }
}
