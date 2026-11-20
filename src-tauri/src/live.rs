//! Live session runner: moves audio from the capture tap's `Chunker` to a
//! cloud transcription stream on a background thread, and stops both in
//! order. It knows nothing about Tauri, so the session lifecycle can be tested
//! with synthetic audio and a scripted stream. Nothing here records or keeps
//! audio; chunks go straight to the stream and are dropped after use. The
//! stream sends nothing until the session's review is approved.

use crate::{
    audio_tap::Chunker,
    transcription::cloud::{CloudFeed, CloudStats},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::Duration,
};

/// How often the runner moves queued audio to the stream.
pub const DRAIN_EVERY: Duration = Duration::from_millis(250);
/// How long a normal stop waits for the stream's last results.
pub const FINISH_WAIT: Duration = Duration::from_secs(10);

/// What the runner saw, for diagnostics and tests. Contains no audio or text.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub transcription: CloudStats,
    /// Device samples dropped because the tap's ring was full.
    pub tap_overruns: u64,
}

pub struct LiveSession {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<(Chunker, Box<CloudFeed>)>>,
    session_start_ms: u64,
}

impl LiveSession {
    /// Starts moving audio from `chunker` to a cloud stream. `session` and
    /// `session_start_ms` come from the engine when capture starts, so line
    /// times line up with its clock. The feed sends nothing until the
    /// session's review is approved, and only its finals reach the engine.
    pub fn start_cloud(
        mut chunker: Chunker,
        session: u64,
        session_start_ms: u64,
        feed: CloudFeed,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let mut feed = Box::new(feed);
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
                        push(&mut feed, chunk);
                    }
                    // A failed stream refuses further audio; nothing falls
                    // back to another recognizer. The failure is reported
                    // through the feed.
                    let _ = feed.poll();
                    std::thread::sleep(DRAIN_EVERY);
                }
                (chunker, feed)
            })
            .expect("live session thread starts");
        Self {
            stop,
            thread: Some(thread),
            session_start_ms,
        }
    }

    /// Stops after capture has stopped: sends the remaining audio, then
    /// closes the stream and waits for its last results. Call without
    /// holding the engine lock, because delivering lines takes it.
    pub fn stop(mut self) -> Report {
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Report::default();
        };
        let Ok((mut chunker, mut feed)) = thread.join() else {
            return Report::default();
        };
        for chunk in chunker.finish(self.session_start_ms) {
            push(&mut feed, chunk);
        }
        Report {
            tap_overruns: chunker.overruns(),
            transcription: feed.finish(FINISH_WAIT),
        }
    }

    /// Stops at once for End: queued audio and results in progress are
    /// discarded, and nothing more reaches the engine.
    pub fn end(mut self) -> Report {
        self.stop.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Report::default();
        };
        let Ok((chunker, feed)) = thread.join() else {
            return Report::default();
        };
        Report {
            tap_overruns: chunker.overruns(),
            transcription: feed.end(),
        }
    }
}

fn push(feed: &mut CloudFeed, chunk: crate::transcription::AudioChunk) {
    let end_ms = chunk.start_ms
        + (chunk.samples.len() as u64 * 1_000) / crate::transcription::SAMPLE_RATE as u64;
    let _ = feed.push(chunk.start_ms, end_ms, &chunk.samples);
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            if let Ok((_, feed)) = thread.join() {
                feed.end();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audio_tap::tap,
        engine::{Engine, Segment},
        transcription::{
            cloud::{Full, StreamingTranscriber, SttEvent},
            SAMPLE_RATE,
        },
    };
    use std::sync::{atomic::AtomicU64, mpsc, Mutex};

    /// A scripted stream: each full second of loud audio it is sent becomes
    /// one final with a fixed line; silence becomes nothing. Finish returns
    /// a final for any loud audio left over. Records whether it was aborted.
    #[derive(Clone)]
    struct Loudness {
        line: &'static str,
        loud: Arc<AtomicU64>,
        received: Arc<AtomicU64>,
        finals: Arc<AtomicU64>,
        aborted: Arc<AtomicBool>,
    }

    impl Loudness {
        fn new(line: &'static str) -> Self {
            Self {
                line,
                loud: Arc::default(),
                received: Arc::default(),
                finals: Arc::default(),
                aborted: Arc::default(),
            }
        }

        fn final_(&self, start: u64, samples: u64) -> SttEvent {
            let seq = self.finals.fetch_add(1, Ordering::SeqCst) + 1;
            let start_ms = start * 1_000 / SAMPLE_RATE as u64;
            SttEvent::Final {
                seq,
                text: self.line.into(),
                start_ms,
                end_ms: start_ms + samples * 1_000 / SAMPLE_RATE as u64,
                untrusted_speaker: Some(0),
            }
        }
    }

    impl StreamingTranscriber for Loudness {
        fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
            let loud = samples.iter().filter(|sample| sample.abs() > 0.1).count() as u64;
            self.loud.fetch_add(loud, Ordering::SeqCst);
            self.received
                .fetch_add(samples.len() as u64, Ordering::SeqCst);
            Ok(())
        }
        fn poll(&mut self) -> Vec<SttEvent> {
            let loud = self.loud.load(Ordering::SeqCst);
            if loud < SAMPLE_RATE as u64 {
                return vec![SttEvent::Partial];
            }
            self.loud.fetch_sub(SAMPLE_RATE as u64, Ordering::SeqCst);
            let end = self.received.load(Ordering::SeqCst);
            vec![self.final_(end.saturating_sub(loud), SAMPLE_RATE as u64)]
        }
        fn finish(&mut self, _: Duration) -> Vec<SttEvent> {
            let mut events = self.poll();
            let left = self.loud.swap(0, Ordering::SeqCst);
            if left > 0 {
                let end = self.received.load(Ordering::SeqCst);
                events.push(self.final_(end - left, left));
            }
            events
        }
        fn abort(&mut self) {
            self.aborted.store(true, Ordering::SeqCst);
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
        impl FnMut(u64, Segment) -> Result<(), String> + Send + 'static,
        mpsc::Receiver<bool>,
    ) {
        let engine = engine.clone();
        let (report, outcomes) = mpsc::channel();
        (
            move |session, segment: Segment| {
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

    /// A session fed through `stream`, approved from the start.
    fn session_with(
        engine: &Arc<Mutex<Engine>>,
        chunker: Chunker,
        stream: &Loudness,
    ) -> (LiveSession, mpsc::Receiver<bool>) {
        let session = engine.lock().unwrap().session();
        let (sink, outcomes) = sink(engine);
        let opened = stream.clone();
        let feed = CloudFeed::new(
            session,
            2,
            Box::new(move || Ok(Box::new(opened) as Box<dyn StreamingTranscriber>)),
            || Some(0),
            sink,
        );
        (
            LiveSession::start_cloud(chunker, session, 0, feed),
            outcomes,
        )
    }

    #[test]
    fn captured_speech_becomes_a_sourced_question_and_stop_flushes_the_rest() {
        let engine = live_engine();
        let (mut input, chunker) = tap(16_000, 1, 100);
        let stream = Loudness::new("Someone can take the first draft.");
        let (live, outcomes) = session_with(&engine, chunker, &stream);
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
            report.transcription.accepted, 2,
            "the final half second is transcribed too"
        );
        assert_eq!(report.tap_overruns, 0);
        assert!(!stream.aborted.load(Ordering::SeqCst));
    }

    /// One whole live session with a scripted stream: speech, a cue, a
    /// flushing Stop, then a second session ended with audio still queued.
    /// Run only in a child process by the test below.
    #[test]
    #[ignore = "run in a child process by the test below"]
    fn isolated_live_session() {
        for flush in [true, false] {
            let engine = live_engine();
            let (mut input, chunker) = tap(16_000, 1, 100);
            let stream = Loudness::new("Someone can take the first draft.");
            let (live, outcomes) = session_with(&engine, chunker, &stream);
            input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE));
            assert!(outcomes.recv_timeout(Duration::from_secs(5)).unwrap());
            assert_eq!(engine.lock().unwrap().state.transcript.len(), 1);
            input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE / 2));
            if flush {
                assert_eq!(live.stop().transcription.accepted, 2);
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
        let (mut input, chunker) = tap(48_000, 2, 100);
        let stream = Loudness::new("unused");
        let (live, _) = session_with(&engine, chunker, &stream);
        input.push_interleaved(std::iter::repeat_n(0.0, 48_000 * 2 * 2));
        std::thread::sleep(DRAIN_EVERY * 3);
        let report = live.stop();
        assert_eq!(report.transcription.accepted, 0);
        assert!(report.transcription.sent_ms > 0, "silence is still sent");
        assert!(engine.lock().unwrap().state.transcript.is_empty());
    }

    #[test]
    fn end_discards_queued_audio_and_nothing_more_reaches_the_engine() {
        let engine = live_engine();
        let (mut input, chunker) = tap(16_000, 1, 100);
        let stream = Loudness::new("Someone can take it.");
        let (live, _) = session_with(&engine, chunker, &stream);
        engine.lock().unwrap().end();
        input.push_interleaved(std::iter::repeat_n(0.5, SAMPLE_RATE * 3));
        let report = live.end();
        assert_eq!(report.transcription.accepted, 0);
        assert!(engine.lock().unwrap().state.transcript.is_empty());
    }

    #[test]
    fn dropping_a_session_stops_its_threads() {
        let engine = live_engine();
        let (_input, chunker) = tap(16_000, 1, 100);
        let stream = Loudness::new("unused");
        let (live, _) = session_with(&engine, chunker, &stream);
        drop(live); // must return rather than hang
    }

    #[test]
    fn only_finals_reach_the_engine_on_the_capture_clock() {
        let engine = live_engine();
        let session = engine.lock().unwrap().session();
        let (mut input, chunker) = tap(16_000, 1, 100);
        let stream = Loudness::new("Someone can take the first draft.");
        let (live, outcomes) = session_with(&engine, chunker, &stream);
        // Under a second of speech: partials only, so nothing is delivered.
        input.push_interleaved(std::iter::repeat_n(0.0, SAMPLE_RATE / 5));
        input.push_interleaved(std::iter::repeat_n(0.3, SAMPLE_RATE / 2));
        std::thread::sleep(DRAIN_EVERY * 3);
        assert!(outcomes.try_recv().is_err());
        let report = live.stop();
        assert!(outcomes.recv_timeout(Duration::from_secs(2)).unwrap());
        assert_eq!(report.transcription.accepted, 1);
        let engine = engine.lock().unwrap();
        let line = engine.state.transcript.last().unwrap();
        assert_eq!((line.at_ms, line.speaker.as_str()), (200, "Speaker"));
        assert!(line.id.starts_with(&format!("c{session}-2-")));
    }
}
