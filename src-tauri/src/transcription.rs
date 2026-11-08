//! Transcription worker: turns queued audio chunks into transcript segments
//! for one session, off the audio callback. The capture side hands over a
//! chunk with `submit`, which does not wait for the worker; inference,
//! parsing, and engine updates happen on the worker thread. Nothing here
//! records or retains audio, and no recognizer is connected to the app yet.

#[cfg(feature = "local-whisper")]
pub mod whisper;

use crate::engine::Segment;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{channel, sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    time::Duration,
};

/// 16 kHz mono samples, the input format local Whisper models expect.
pub const SAMPLE_RATE: usize = 16_000;
/// Longest chunk accepted, so one call cannot hold the worker for long.
pub const MAX_CHUNK_SECONDS: usize = 30;
/// How long `stop` waits for a recognizer call to finish before detaching.
pub const STOP_WAIT: Duration = Duration::from_secs(2);

/// Distinguishes workers within one session, so a restarted worker (for
/// example after Pause) never reuses a segment ID.
static NEXT_WORKER: AtomicU64 = AtomicU64::new(0);

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
    /// Recognized lines discarded before delivery because their offset fell
    /// outside the chunk.
    pub out_of_range: u64,
    /// Chunks refused at submit because the queue was full, the worker had
    /// stopped, or the chunk was too long.
    pub dropped: u64,
    /// Recognizer errors; the worker continues with the next chunk.
    pub failures: u64,
    /// True when `stop` gave up waiting and detached the worker thread; its
    /// remaining results are discarded and the other counts are incomplete.
    pub detached: bool,
}

pub struct Worker {
    sender: Option<SyncSender<AudioChunk>>,
    cancelled: Arc<AtomicBool>,
    dropped: AtomicU64,
    queued: AtomicU64,
    completed: Arc<AtomicU64>,
    finished: Option<Receiver<Stats>>,
}

impl Worker {
    /// Starts a worker for `session` (from `Engine::session()`) with room for
    /// `capacity` waiting chunks. `sink` delivers each segment, normally by
    /// locking the engine and calling `Engine::ingest`. Because the sink takes
    /// the engine lock, call `cancel` or `stop` without holding that lock.
    pub fn start<T, S>(session: u64, capacity: usize, transcriber: T, sink: S) -> Self
    where
        T: Transcriber,
        S: FnMut(u64, Segment) -> Result<(), String> + Send + 'static,
    {
        let (sender, receiver) = sync_channel(capacity.max(1));
        let (done, finished) = channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let worker = NEXT_WORKER.fetch_add(1, Ordering::Relaxed);
        let completed = Arc::new(AtomicU64::new(0));
        let finished_chunks = completed.clone();
        std::thread::Builder::new()
            .name("talkqte-transcription".into())
            .spawn(move || {
                let _ = done.send(run(
                    session,
                    worker,
                    receiver,
                    flag,
                    finished_chunks,
                    transcriber,
                    sink,
                ));
            })
            .expect("transcription worker thread starts");
        Self {
            sender: Some(sender),
            cancelled,
            dropped: AtomicU64::new(0),
            queued: AtomicU64::new(0),
            completed,
            finished: Some(finished),
        }
    }

    /// Queues a chunk without waiting for the worker. When the queue is
    /// full, the worker is stopping, or the chunk is longer than
    /// `MAX_CHUNK_SECONDS`, the chunk is counted as dropped and handed back,
    /// so a capture callback can reuse the buffer instead of freeing it.
    /// Dropped audio is not retried; the transcript simply has a gap.
    pub fn submit(&self, chunk: AudioChunk) -> Result<(), AudioChunk> {
        let refused = if chunk.samples.len() > SAMPLE_RATE * MAX_CHUNK_SECONDS
            || self.cancelled.load(Ordering::Acquire)
        {
            Some(chunk)
        } else {
            match self.sender.as_ref().map(|sender| sender.try_send(chunk)) {
                Some(Ok(())) => None,
                Some(Err(TrySendError::Full(chunk) | TrySendError::Disconnected(chunk))) => {
                    Some(chunk)
                }
                None => unreachable!("the sender lives until stop"),
            }
        };
        match refused {
            None => {
                self.queued.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Some(chunk) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Err(chunk)
            }
        }
    }

    /// Chunks accepted by `submit` that the worker has not finished, whether
    /// waiting or being transcribed. A growing backlog means recognition is
    /// falling behind the audio.
    pub fn backlog(&self) -> u64 {
        self.queued
            .load(Ordering::Relaxed)
            .saturating_sub(self.completed.load(Ordering::Acquire))
    }

    /// Cancels without waiting: no further results are delivered, and
    /// queued chunks are discarded. Safe to call while holding the engine
    /// lock, unlike `stop`.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    /// Cancels, then waits up to `STOP_WAIT` for a recognizer call in
    /// progress to return. Its results are not delivered. If the recognizer
    /// does not return in time, the thread is detached and finishes on its
    /// own without delivering anything.
    pub fn stop(mut self) -> Stats {
        self.shutdown()
    }

    fn shutdown(&mut self) -> Stats {
        self.cancel();
        self.sender.take();
        let mut stats = match self
            .finished
            .take()
            .map(|done| done.recv_timeout(STOP_WAIT))
        {
            Some(Ok(stats)) => stats,
            _ => Stats {
                detached: true,
                ..Stats::default()
            },
        };
        stats.dropped = self.dropped.load(Ordering::Relaxed);
        stats
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if self.finished.is_some() {
            self.shutdown();
        }
    }
}

fn run<T: Transcriber, S: FnMut(u64, Segment) -> Result<(), String>>(
    session: u64,
    worker: u64,
    receiver: Receiver<AudioChunk>,
    cancelled: Arc<AtomicBool>,
    completed: Arc<AtomicU64>,
    mut transcriber: T,
    mut sink: S,
) -> Stats {
    let stopped = || cancelled.load(Ordering::Acquire);
    let mut stats = Stats::default();
    let mut next_id = 0u64;
    while let Ok(chunk) = receiver.recv() {
        if stopped() {
            break;
        }
        let recognized = transcriber.transcribe(&chunk);
        stats.chunks += 1;
        let mut items = match recognized {
            Ok(items) => items,
            Err(_) => {
                stats.failures += 1;
                completed.fetch_add(1, Ordering::Release);
                continue;
            }
        };
        // The engine refuses out-of-order lines, so deliver in time order.
        items.sort_by_key(|item| item.offset_ms);
        // Count lines outside the chunk before delivery, so the count does
        // not depend on whether a stop arrives mid-delivery.
        let length_ms = (chunk.samples.len() * 1_000 / SAMPLE_RATE) as u64;
        let recognized_lines = items.len();
        items.retain(|item| item.offset_ms <= length_ms);
        stats.out_of_range += (recognized_lines - items.len()) as u64;
        for item in items {
            // A stop during inference or delivery discards what is left.
            if stopped() {
                return stats;
            }
            let segment = Segment {
                id: format!("t{session}-{worker}-{next_id}"),
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
        completed.fetch_add(1, Ordering::Release);
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use std::sync::{mpsc, Mutex};

    type Lines = Vec<Result<Vec<(u64, &'static str)>, &'static str>>;

    /// Returns scripted lines, one call per chunk. Optionally reports each
    /// call starting and waits for the test to open a gate.
    struct Script {
        lines: Lines,
        started: Option<mpsc::Sender<()>>,
        gate: Option<mpsc::Receiver<()>>,
        calls: Arc<AtomicU64>,
    }

    impl Transcriber for Script {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            if let Some(started) = &self.started {
                let _ = started.send(());
            }
            if let Some(gate) = &self.gate {
                let _ = gate.recv();
            }
            let index = self.calls.fetch_add(1, Ordering::SeqCst) as usize;
            match self.lines.get(index).cloned().unwrap_or(Ok(vec![])) {
                Ok(lines) => Ok(lines
                    .into_iter()
                    .map(|(offset_ms, text)| Recognized {
                        offset_ms,
                        speaker: "Speaker 1".into(),
                        text: text.into(),
                    })
                    .collect()),
                Err(message) => Err(message.into()),
            }
        }
    }

    fn script(lines: Lines) -> Script {
        Script {
            lines,
            started: None,
            gate: None,
            calls: Arc::new(AtomicU64::new(0)),
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

    #[test]
    fn recognized_speech_raises_a_sourced_question_and_its_answer_withdraws_it() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (sink, outcomes) = into_engine(&engine);
        let lines = vec![
            Ok(vec![(0, "Someone can take the first draft.")]),
            Ok(vec![(0, "Jordan will take it.")]),
        ];
        let worker = Worker::start(session, 4, script(lines), sink);
        assert!(worker.submit(chunk(64_000)).is_ok());
        assert!(outcomes.recv().unwrap());
        {
            let engine = engine.lock().unwrap();
            let cue = engine
                .state
                .cue
                .as_ref()
                .expect("a question from recognized speech");
            assert!(cue.source_id.starts_with(&format!("t{session}-")));
            assert_eq!(engine.state.transcript.last().unwrap().at_ms, 64_000);
        }
        assert!(worker.submit(chunk(65_000)).is_ok());
        assert!(outcomes.recv().unwrap());
        assert!(
            engine.lock().unwrap().state.cue.is_none(),
            "answered question withdrawn"
        );
        assert_eq!(
            worker.stop(),
            Stats {
                chunks: 2,
                accepted: 2,
                ..Stats::default()
            }
        );
    }

    #[test]
    fn a_full_queue_hands_audio_back_instead_of_blocking_the_caller() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (open, gate) = mpsc::channel();
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(
            session,
            2,
            Script {
                gate: Some(gate),
                ..script(vec![])
            },
            sink,
        );
        let accepted = (0..6)
            .filter(|n| worker.submit(chunk(60_000 + n * 1_000)).is_ok())
            .count();
        // One chunk may be inside the recognizer and two waiting; the rest drop.
        assert!((2..=3).contains(&accepted), "accepted {accepted}");
        for _ in 0..6 {
            let _ = open.send(());
        }
        assert_eq!(worker.stop().dropped, 6 - accepted as u64);
    }

    #[test]
    fn backlog_counts_accepted_chunks_until_the_worker_finishes_them() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (started, recognizing) = mpsc::channel();
        let (open, gate) = mpsc::channel();
        let lines = vec![Ok(vec![(0, "Hello.")]), Err("model unavailable")];
        let script = Script {
            started: Some(started),
            gate: Some(gate),
            ..script(lines)
        };
        let (sink, outcomes) = into_engine(&engine);
        let worker = Worker::start(session, 4, script, sink);
        assert_eq!(worker.backlog(), 0);
        assert!(worker.submit(chunk(60_000)).is_ok());
        assert!(worker.submit(chunk(61_000)).is_ok());
        recognizing.recv().unwrap();
        assert_eq!(worker.backlog(), 2, "one in progress, one waiting");
        open.send(()).unwrap();
        assert!(outcomes.recv().unwrap());
        recognizing.recv().unwrap();
        open.send(()).unwrap(); // The second call fails; it still completes.
        while worker.backlog() > 0 {
            std::thread::yield_now();
        }
        assert_eq!(worker.stop().failures, 1);
    }

    #[test]
    fn refused_audio_comes_back_to_the_caller_intact() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(session, 2, script(vec![]), sink);
        let samples = vec![0.25; SAMPLE_RATE * MAX_CHUNK_SECONDS + 1];
        let back = worker
            .submit(AudioChunk {
                start_ms: 60_000,
                samples,
            })
            .unwrap_err();
        assert_eq!(back.samples.len(), SAMPLE_RATE * MAX_CHUNK_SECONDS + 1);
        worker.cancel();
        assert!(
            worker.submit(chunk(60_000)).is_err(),
            "refused after cancel"
        );
        assert_eq!(worker.stop().dropped, 2);
    }

    #[test]
    fn ending_the_session_rejects_late_results_without_changing_the_transcript() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (open, gate) = mpsc::channel();
        let lines = vec![Ok(vec![(0, "Someone can take the first draft.")])];
        let (sink, outcomes) = into_engine(&engine);
        let worker = Worker::start(
            session,
            2,
            Script {
                gate: Some(gate),
                ..script(lines)
            },
            sink,
        );
        assert!(worker.submit(chunk(64_000)).is_ok());
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
    fn cancelling_discards_queued_audio_and_results_in_progress() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (started, recognizing) = mpsc::channel();
        let (open, gate) = mpsc::channel();
        let calls = Arc::new(AtomicU64::new(0));
        let lines = vec![
            Ok(vec![(0, "Hello.")]),
            Ok(vec![(0, "Again.")]),
            Ok(vec![(0, "More.")]),
        ];
        let script = Script {
            lines,
            started: Some(started),
            gate: Some(gate),
            calls: calls.clone(),
        };
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(session, 4, script, sink);
        for n in 0..3 {
            assert!(worker.submit(chunk(60_000 + n * 1_000)).is_ok());
        }
        let before = engine.lock().unwrap().state.transcript.len();
        recognizing.recv().unwrap(); // The first call is in progress.
        worker.cancel();
        open.send(()).unwrap();
        let stats = worker.stop();
        assert_eq!(stats.accepted, 0, "nothing delivered after cancel");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "queued chunks discarded");
        assert_eq!(engine.lock().unwrap().state.transcript.len(), before);
    }

    #[test]
    fn cancelling_during_delivery_drops_the_remaining_lines() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let lines = vec![Ok(vec![(0, "One."), (100, "Two."), (200, "Three.")])];
        let (cancel_tx, cancel_rx) = mpsc::channel::<Arc<AtomicBool>>();
        let inner = engine.clone();
        // The sink cancels its own worker after the first delivery.
        let sink = move |session, segment| {
            let result = inner.lock().unwrap().ingest(session, segment);
            if let Ok(flag) = cancel_rx.try_recv() {
                flag.store(true, Ordering::Release);
            }
            result
        };
        let worker = Worker::start(session, 2, script(lines), sink);
        cancel_tx.send(worker.cancelled.clone()).unwrap();
        assert!(worker.submit(chunk(64_000)).is_ok());
        let stats = worker.stop();
        assert!(stats.accepted <= 1, "accepted {}", stats.accepted);
    }

    #[test]
    fn lines_are_delivered_in_time_order_and_out_of_range_offsets_are_skipped() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let lines = vec![Ok(vec![
            (700, "Second."),
            (100, "First."),
            (5_000, "Beyond the chunk."),
        ])];
        let (sink, outcomes) = into_engine(&engine);
        let worker = Worker::start(session, 2, script(lines), sink);
        assert!(worker.submit(chunk(64_000)).is_ok());
        assert!(outcomes.recv().unwrap() && outcomes.recv().unwrap());
        let stats = worker.stop();
        assert_eq!((stats.accepted, stats.out_of_range), (2, 1));
        let engine = engine.lock().unwrap();
        let texts: Vec<_> = engine
            .state
            .transcript
            .iter()
            .rev()
            .take(2)
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(texts, ["Second.", "First."]);
    }

    #[test]
    fn a_restarted_worker_in_the_same_session_never_reuses_segment_ids() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        for start in [60_000, 61_000] {
            let (sink, outcomes) = into_engine(&engine);
            let worker = Worker::start(session, 2, script(vec![Ok(vec![(0, "Hello.")])]), sink);
            assert!(worker.submit(chunk(start)).is_ok());
            assert!(outcomes.recv().unwrap(), "accepted, not a duplicate ID");
            worker.stop();
        }
    }

    #[test]
    fn stop_gives_up_on_a_hung_recognizer_instead_of_hanging() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (started, recognizing) = mpsc::channel();
        let (_never_opened, gate) = mpsc::channel();
        let script = Script {
            started: Some(started),
            gate: Some(gate),
            ..script(vec![])
        };
        let (sink, _) = into_engine(&engine);
        let worker = Worker::start(session, 2, script, sink);
        assert!(worker.submit(chunk(60_000)).is_ok());
        recognizing.recv().unwrap();
        let begun = std::time::Instant::now();
        let stats = worker.stop();
        assert!(stats.detached);
        assert!(begun.elapsed() < STOP_WAIT + Duration::from_secs(1));
    }

    #[test]
    fn a_recognizer_error_skips_one_chunk_and_the_worker_continues() {
        let engine = running_engine();
        let session = engine.lock().unwrap().session();
        let (sink, outcomes) = into_engine(&engine);
        let lines = vec![Err("model unavailable"), Ok(vec![(0, "Hello.")])];
        let worker = Worker::start(session, 4, script(lines), sink);
        assert!(worker.submit(chunk(60_000)).is_ok());
        assert!(worker.submit(chunk(61_000)).is_ok());
        assert!(outcomes.recv().unwrap());
        let stats = worker.stop();
        assert_eq!((stats.chunks, stats.failures, stats.accepted), (2, 1, 1));
    }
}
