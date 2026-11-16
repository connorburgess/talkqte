//! Live session runner: moves audio from the capture tap's `Chunker` to the
//! transcription `Worker` on a background thread, and stops both in order.
//! It knows nothing about Tauri, so the session lifecycle can be tested with
//! synthetic audio and a scripted recognizer. Nothing here records or keeps
//! audio; chunks go straight to the worker and are dropped after use.

use crate::{
    audio_tap::Chunker,
    engine::Segment,
    transcription::{cloud::CloudFeed, AudioChunk, CancelHandle, Stats, Transcriber, Worker},
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
    // Lets End cancel a local worker before joining the runner that owns it.
    cancel: Option<CancelHandle>,
    thread: Option<JoinHandle<(Chunker, Running)>>,
    session_start_ms: u64,
}

/// What the runner feeds: a local recognizer's worker, or a cloud stream.
enum Running {
    Local(Worker),
    Cloud(Box<CloudFeed>),
}

impl Running {
    fn take(&mut self, chunk: AudioChunk, refused: &AtomicU64) {
        match self {
            Self::Local(worker) => {
                if worker.submit(chunk).is_err() {
                    refused.fetch_add(1, Ordering::Relaxed);
                }
            }
            Self::Cloud(feed) => {
                let end_ms = chunk.start_ms
                    + (chunk.samples.len() as u64 * 1_000)
                        / crate::transcription::SAMPLE_RATE as u64;
                // A failed stream refuses further audio; nothing falls back to
                // another recognizer. The failure is in the timing log.
                let _ = feed.push(chunk.start_ms, end_ms, &chunk.samples);
            }
        }
    }

    fn poll(&mut self) {
        if let Self::Cloud(feed) = self {
            let _ = feed.poll();
        }
    }

    fn finish(self, wait: Duration) -> Stats {
        match self {
            Self::Local(worker) => worker.finish(wait),
            Self::Cloud(feed) => cloud_stats(feed.finish(wait)),
        }
    }

    fn stop(self) -> Stats {
        match self {
            Self::Local(worker) => worker.stop(),
            Self::Cloud(feed) => cloud_stats(feed.end()),
        }
    }
}

fn cloud_stats(counts: crate::transcription::cloud::CloudStats) -> Stats {
    Stats {
        accepted: counts.accepted,
        rejected: counts.rejected,
        ..Stats::default()
    }
}

impl LiveSession {
    /// Starts moving audio from `chunker` to a worker running `transcriber`.
    /// `session` and `session_start_ms` come from the engine when capture
    /// starts, so segment times line up with its clock. `sink` delivers each
    /// recognized line, normally into `Engine::ingest`.
    pub fn start<T, S>(
        chunker: Chunker,
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
        let cancel = worker.cancel_handle();
        Self::run(
            chunker,
            session,
            session_start_ms,
            Running::Local(worker),
            Some(cancel),
        )
    }

    /// Starts moving audio from `chunker` to a cloud stream. The feed sends
    /// nothing until the session's review is approved, and only its finals
    /// reach the engine.
    pub fn start_cloud(
        chunker: Chunker,
        session: u64,
        session_start_ms: u64,
        feed: CloudFeed,
    ) -> Self {
        Self::run(
            chunker,
            session,
            session_start_ms,
            Running::Cloud(Box::new(feed)),
            None,
        )
    }

    fn run(
        mut chunker: Chunker,
        session: u64,
        session_start_ms: u64,
        mut running: Running,
        cancel: Option<CancelHandle>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let refused = Arc::new(AtomicU64::new(0));
        let (flag, count) = (stop.clone(), refused.clone());
        let thread = std::thread::Builder::new()
            .name("talkqte-live-session".into())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    for chunk in chunker.drain(session_start_ms) {
                        crate::timing_log::record_audio(
                            "microphone",
                            session,
                            chunk.start_ms,
                            &chunk.samples,
                        );
                        running.take(chunk, &count);
                    }
                    running.poll();
                    std::thread::sleep(DRAIN_EVERY);
                }
                (chunker, running)
            })
            .expect("live session thread starts");
        Self {
            stop,
            refused,
            cancel,
            thread: Some(thread),
            session_start_ms,
        }
    }

    /// Stops after capture has stopped: hands the remaining audio on, then
    /// stops the worker or closes the stream. Call without holding the
    /// engine lock, because delivering lines takes it.
    pub fn stop(mut self) -> Report {
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Report::default();
        };
        let Ok((mut chunker, mut running)) = thread.join() else {
            return Report::default();
        };
        for chunk in chunker.finish(self.session_start_ms) {
            running.take(chunk, &self.refused);
        }
        Report {
            tap_overruns: chunker.overruns(),
            refused_chunks: self.refused.load(Ordering::Relaxed),
            worker: running.finish(FINISH_WAIT),
        }
    }

    /// Stops at once for End: queued audio and results in progress are
    /// discarded, and nothing more reaches the engine.
    pub fn end(mut self) -> Report {
        // Cancel first: the runner may still be sleeping between drains.
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Report::default();
        };
        let Ok((chunker, running)) = thread.join() else {
            return Report::default();
        };
        Report {
            tap_overruns: chunker.overruns(),
            refused_chunks: self.refused.load(Ordering::Relaxed),
            worker: running.stop(),
        }
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            if let Ok((_, running)) = thread.join() {
                running.stop();
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
        transcription::{Recognized, SAMPLE_RATE},
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

    /// One whole live session with a scripted recognizer: speech, a cue, a
    /// flushing Stop, then a second session ended with audio still queued.
    /// Run only in a child process by the test below.
    #[test]
    #[ignore = "run in a child process by the test below"]
    fn isolated_live_session() {
        for flush in [true, false] {
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
            input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE));
            assert!(outcomes.recv_timeout(Duration::from_secs(5)).unwrap());
            assert_eq!(engine.lock().unwrap().state.transcript.len(), 1);
            input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE / 2));
            if flush {
                assert_eq!(live.stop().worker.chunks, 2);
            } else {
                live.end();
            }
        }
    }

    #[test]
    fn a_live_session_writes_no_file_and_prints_nothing() {
        let crate::test_isolation::Isolated { left, printed } =
            crate::test_isolation::run("live::tests::isolated_live_session", &[], &[]);
        assert!(left.is_empty(), "the session left files: {left:?}");
        // Neither what was heard nor the question it raised.
        for private in ["Someone can take", "first draft"] {
            assert!(!printed.contains(private), "printed {private}: {printed}");
        }
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

    #[test]
    fn a_cloud_session_delivers_only_finals_and_stop_closes_the_stream() {
        use crate::transcription::cloud::{Full, StreamingTranscriber, SttEvent};
        #[derive(Clone, Default)]
        struct Stream {
            sent: Arc<AtomicU64>,
            finished: Arc<AtomicBool>,
        }
        impl StreamingTranscriber for Stream {
            fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
                self.sent.fetch_add(samples.len() as u64, Ordering::SeqCst);
                Ok(())
            }
            fn poll(&mut self) -> Vec<SttEvent> {
                if self.sent.load(Ordering::SeqCst) >= SAMPLE_RATE as u64 {
                    vec![SttEvent::Partial]
                } else {
                    vec![]
                }
            }
            fn finish(&mut self, _: Duration) -> Vec<SttEvent> {
                self.finished.store(true, Ordering::SeqCst);
                vec![SttEvent::Final {
                    seq: 1,
                    text: "Someone can take the first draft.".into(),
                    start_ms: 200,
                    end_ms: 900,
                    untrusted_speaker: Some(0),
                }]
            }
            fn abort(&mut self) {}
        }
        let engine = live_engine();
        let session = engine.lock().unwrap().session();
        let (mut input, chunker) = tap(16_000, 1, 100);
        let (sink, outcomes) = sink(&engine);
        let stream = Stream::default();
        let opened = stream.clone();
        let feed = CloudFeed::new(
            session,
            2,
            Box::new(move || Ok(Box::new(opened) as Box<dyn StreamingTranscriber>)),
            || Some(0),
            sink,
        );
        let live = LiveSession::start_cloud(chunker, session, 0, feed);
        input.push_interleaved(std::iter::repeat_n(0.3, SAMPLE_RATE * 2));
        std::thread::sleep(DRAIN_EVERY * 3);
        // Partials so far: nothing has reached the engine.
        assert!(outcomes.try_recv().is_err());
        let report = live.stop();
        assert!(stream.finished.load(Ordering::SeqCst));
        assert!(outcomes.recv_timeout(Duration::from_secs(2)).unwrap());
        assert_eq!(report.worker.accepted, 1);
        let engine = engine.lock().unwrap();
        let line = engine.state.transcript.last().unwrap();
        assert_eq!((line.at_ms, line.speaker.as_str()), (200, "Speaker"));
        assert!(line.id.starts_with(&format!("c{session}-2-")));
    }
}
