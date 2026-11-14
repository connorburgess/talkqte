//! Development-only host loop for one selected application's audio. It runs on
//! the worker that owns the native selection: measure and accept the clock
//! (which attaches the source to the live session), begin the approved
//! selection, then move blocks to chunks, a transcription worker and the
//! runtime's source sink until native cleanup is released. Called only by the
//! development host in `application_audio_host`; nothing here was run against
//! a device.

use crate::{
    application_audio::{
        handoff::{Rejected, MAX_BLOCKS},
        native::{
            ClockBinding, NativeBlock, NativeChunk, NativeChunker, NativeOwner, NativeReader,
            Selection, Stage, Status,
        },
        timing::TimingError,
        Control, Failure, Start,
    },
    live::WORKER_QUEUE,
    live_source::LineRefused,
    native_session_clock::{Measurement, Snapshot},
    transcription::{Stats, Transcriber, Worker},
    Runtime,
};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

/// How often the loop checks native completions when no audio is waiting.
/// Not a latency bound for Stop or delivery.
const POLL: Duration = Duration::from_millis(20);
/// Passes between checks that the source is still attached, so a source that
/// produces no lines is also stopped when it should not be capturing. Counted
/// in passes, not time: a throttled or starved thread makes fewer passes, so
/// in wall time this check has no upper bound.
const ATTACHED_EVERY: u32 = 50;

/// How the loop paces itself. The app always uses `Pace::APP`; tests choose a
/// pace so that what they assert depends on passes, not on runner speed.
#[derive(Clone, Copy)]
struct Pace {
    /// Park this long on a pass that found no audio.
    poll: Duration,
    /// Ask the runtime whether the source is attached on every pass whose
    /// number is a multiple of this.
    attached_every: u32,
}

impl Pace {
    const APP: Self = Self {
        poll: POLL,
        attached_every: ATTACHED_EVERY,
    };
}

/// How the worker reaches the runtime. `with` runs its closure under the
/// runtime lock and returns `None` when the runtime is unavailable. An app
/// implementation may publish state afterwards; it must not block in between.
pub(crate) trait Access: Clone + Send + 'static {
    fn with<R>(&self, action: impl FnOnce(&mut Runtime) -> R) -> Option<R>;
}

impl Access for Arc<Mutex<Runtime>> {
    fn with<R>(&self, action: impl FnOnce(&mut Runtime) -> R) -> Option<R> {
        self.lock().ok().map(|mut runtime| action(&mut runtime))
    }
}

/// Explicit host policy for the clock measurement; neither is a proven budget.
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub max_width: Duration,
    pub max_age: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    /// The clock was not accepted, so the source was never attached and no
    /// native request was sent. `Occupied` leaves the attached source running.
    Clock(TimingError),
    /// The native owner refused the approved start.
    Start(Failure),
}

/// Metadata only; no audio or text.
#[derive(Debug)]
pub(crate) struct Report {
    pub status: Status,
    pub worker: Stats,
    /// Chunks the transcription queue had no room for.
    pub refused_chunks: u64,
    /// Width of the accepted host-clock read, to keep with acceptance evidence.
    pub bracket_width: Duration,
}

/// What the host can see and do while the worker runs. Sendable; holds no
/// native object and never the runtime lock.
#[derive(Clone, Default)]
pub(crate) struct Monitor(Arc<Mutex<Watch>>);

#[derive(Default)]
struct Watch {
    status: Option<Status>,
    retry: bool,
    in_retry: bool,
    abandoned: bool,
}

impl Monitor {
    /// The last native stage the worker observed, once it has started. Only
    /// Released means native cleanup was confirmed.
    pub(crate) fn status(&self) -> Option<Status> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).status
    }

    /// True when the worker ended without reaching Released, for example by
    /// a panic. Native capture may still be running: the owner quarantines
    /// its resources instead of claiming a Stop it did not confirm. The last
    /// status is then only what was seen before the worker ended.
    pub(crate) fn abandoned(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).abandoned
    }

    /// Ask for one retry of a Stop or output removal that was observed to
    /// fail. Refused before such a failure, while a retry is waiting or being
    /// performed, and after abandonment. The status is refreshed after a
    /// performed retry, so a second request needs a newly observed failure.
    pub(crate) fn retry_cleanup(&self) -> bool {
        let mut watch = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let failed = watch
            .status
            .is_some_and(|status| matches!(status.stage, Stage::StopFailed | Stage::RemoveFailed));
        if !failed || watch.retry || watch.in_retry || watch.abandoned {
            return false;
        }
        watch.retry = true;
        true
    }

    /// Record the stage and take a waiting retry. The native call happens
    /// after this lock is released; `in_retry` covers it.
    fn observe(&self, status: Status) -> bool {
        let mut watch = self.0.lock().unwrap_or_else(|e| e.into_inner());
        watch.status = Some(status);
        let retry = std::mem::take(&mut watch.retry);
        watch.in_retry = retry;
        retry
    }

    /// Record the stage that followed a performed retry.
    fn retried(&self, status: Status) {
        let mut watch = self.0.lock().unwrap_or_else(|e| e.into_inner());
        watch.status = Some(status);
        watch.in_retry = false;
    }
}

/// Marks the monitor abandoned and closes delivery if the loop ends any way
/// other than through Released.
struct Abandon<'a> {
    monitor: &'a Monitor,
    control: &'a Control,
    released: bool,
}

impl Drop for Abandon<'_> {
    fn drop(&mut self) {
        if !self.released {
            self.control.cancel();
            let mut watch = self.monitor.0.lock().unwrap_or_else(|e| e.into_inner());
            watch.abandoned = true;
        }
    }
}

/// The native owner and its reader, or a scripted pair in tests.
pub(crate) trait Source {
    fn poll(&mut self) -> Status;
    fn retry_cleanup(&mut self) -> bool;
    fn try_next(&mut self, session: u64) -> Result<Option<NativeBlock>, TimingError>;
}

impl Source for (NativeOwner, NativeReader) {
    fn poll(&mut self) -> Status {
        self.0.poll()
    }

    fn retry_cleanup(&mut self) -> bool {
        self.0.retry_cleanup()
    }

    fn try_next(&mut self, session: u64) -> Result<Option<NativeBlock>, TimingError> {
        self.1.try_next(session)
    }
}

struct Accepted {
    session: u64,
    binding: ClockBinding,
    bracket_width: Duration,
}

/// Snapshot under the runtime lock, measure without it, accept under it again.
/// Acceptance is what attaches the source; every failure leaves it unattached.
fn prepare<A: Access>(
    runtime: &A,
    control: &Control,
    measure: impl FnOnce(Snapshot) -> Result<Measurement, TimingError>,
) -> Result<Accepted, TimingError> {
    let snapshot = runtime
        .with(|runtime| runtime.native_clock_snapshot(control))
        .ok_or(TimingError::SessionChanged)??;
    let measurement = measure(snapshot)?;
    let accepted = runtime
        .with(|runtime| runtime.accept_native_clock(measurement))
        .ok_or(TimingError::SessionChanged)??;
    Ok(Accepted {
        session: accepted.session,
        binding: accepted.binding,
        bracket_width: accepted.bracket_width,
    })
}

/// Run one approved selection to release on the calling worker thread, which
/// must be the thread that constructed `selection`. Blocks until the native
/// owner reports Released. A native completion that never arrives keeps this
/// worker and the review gate reserved, by design; a reported Stop or removal
/// failure waits for an explicit `Monitor::retry_cleanup`.
///
/// # Safety
/// The obligations of [`NativeOwner::begin`] apply. The host must have
/// disclosed the application-wide scope and obtained the person's approval for
/// this exact selection, and must never call this from the UI thread, an audio
/// callback or a pool whose shutdown waits for it.
pub(crate) unsafe fn run<A: Access, T: Transcriber>(
    runtime: A,
    start: Start,
    selection: Selection,
    limits: Limits,
    transcriber: T,
    monitor: Monitor,
) -> Result<Report, Refused> {
    run_with(
        runtime,
        start,
        |snapshot| snapshot.measure(limits.max_width, limits.max_age),
        // SAFETY: the caller's obligations are those of this call.
        |start, binding| unsafe { NativeOwner::begin(start, selection, binding) },
        transcriber,
        monitor,
    )
}

/// `run` with its two native steps supplied: the host-clock read and the
/// start of the source. Tests pass a fictional clock and a scripted owner, so
/// the same ordering runs without a stream.
pub(crate) fn run_with<A: Access, T: Transcriber, S: Source>(
    runtime: A,
    start: Start,
    measure: impl FnOnce(Snapshot) -> Result<Measurement, TimingError>,
    begin: impl FnOnce(Start, ClockBinding) -> Result<S, Failure>,
    transcriber: T,
    monitor: Monitor,
) -> Result<Report, Refused> {
    let control = start.control();
    let accepted = prepare(&runtime, &control, measure).map_err(Refused::Clock)?;
    // Before any native request: if this thread cannot be started, nothing
    // has been asked of the OS yet.
    let worker = start_worker(runtime.clone(), accepted.session, &control, transcriber);
    // A refused start drops its lease, which cancels the operation; the next
    // runtime sync then detaches it.
    let source = begin(start, accepted.binding).map_err(Refused::Start)?;
    Ok(pump(
        runtime,
        accepted.session,
        control,
        source,
        worker,
        accepted.bracket_width,
        monitor,
    ))
}

/// The transcription worker whose only sink is the runtime's source sink.
/// A source that turns out not to be attached, or a runtime that cannot be
/// reached, cancels the operation: nothing it captures could be delivered.
fn start_worker<A: Access, T: Transcriber>(
    runtime: A,
    session: u64,
    control: &Control,
    transcriber: T,
) -> Worker<NativeChunk> {
    let control = control.clone();
    Worker::start(
        session,
        WORKER_QUEUE,
        transcriber,
        move |session, segment| {
            let taken =
                runtime.with(|runtime| runtime.ingest_source_line(session, &control, segment));
            match taken {
                Some(Ok(())) => Ok(()),
                Some(Err(LineRefused::Engine(reason))) => Err(reason),
                Some(Err(LineRefused::NotAttached)) => {
                    control.cancel();
                    Err("That audio source is not attached to this live session.".into())
                }
                None => {
                    control.cancel();
                    Err("The session is unavailable.".into())
                }
            }
        },
    )
}

/// Blocks reach the engine only through `Runtime::ingest_source_line`, which
/// refuses a source that is not attached. When reading ends for any reason,
/// including a clean end of input, the operation is cancelled: audio that has
/// not produced a delivered line is discarded, never flushed. Reading also
/// ends when the transcription worker has died or the source is found not to
/// be attached, because capturing would then serve nothing.
fn pump<A: Access, S: Source>(
    runtime: A,
    session: u64,
    control: Control,
    source: S,
    worker: Worker<NativeChunk>,
    bracket_width: Duration,
    monitor: Monitor,
) -> Report {
    pump_paced(
        runtime,
        session,
        control,
        source,
        worker,
        bracket_width,
        monitor,
        Pace::APP,
    )
}

#[allow(clippy::too_many_arguments)]
fn pump_paced<A: Access, S: Source>(
    runtime: A,
    session: u64,
    control: Control,
    mut source: S,
    worker: Worker<NativeChunk>,
    bracket_width: Duration,
    monitor: Monitor,
    pace: Pace,
) -> Report {
    let mut abandon = Abandon {
        monitor: &monitor,
        control: &control,
        released: false,
    };
    let mut chunker = NativeChunker::new(control.clone(), session);
    let mut reading = true;
    let mut refused_chunks = 0;
    let mut passes = 0_u32;
    loop {
        // Native completions first, and on every pass: a silent or retired
        // source must still be stopped, removed and drained.
        let mut status = source.poll();
        if monitor.observe(status) {
            // Accepted only for an observed failure, and the stage changes
            // only on this thread, so it is still that failure.
            source.retry_cleanup();
            status = source.poll();
            monitor.retried(status);
        }
        if status.stage == Stage::Released {
            abandon.released = true;
            return Report {
                status,
                worker: worker.stop(),
                refused_chunks,
                bracket_width,
            };
        }
        passes = passes.wrapping_add(1);
        if reading && !control.is_cancelled() {
            let attached = !passes.is_multiple_of(pace.attached_every)
                || runtime.with(|runtime| runtime.live_source_accepts(session, &control))
                    == Some(true);
            if !attached || !worker.is_running() {
                reading = false;
            }
        }
        let mut idle = true;
        for _ in 0..MAX_BLOCKS {
            if !reading {
                break;
            }
            match source.try_next(session) {
                Ok(Some(block)) => {
                    idle = false;
                    match chunker.push(block, session) {
                        Ok(Some(chunk)) => {
                            crate::timing_log::record_audio(
                                "application",
                                session,
                                chunk.audio().start_ms,
                                &chunk.audio().samples,
                            );
                            if worker.submit(chunk).is_err() {
                                refused_chunks += 1;
                            }
                        }
                        Ok(None) => {}
                        Err(_) => reading = false,
                    }
                }
                Ok(None) | Err(TimingError::Handoff(Rejected::NotReady)) => break,
                Err(_) => reading = false,
            }
        }
        if !reading {
            control.cancel();
        }
        if idle {
            thread::park_timeout(pace.poll);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application_audio::{
            handoff::{Format, Input},
            native::Feed,
            Application, Capture, Gate, Phase,
        },
        native_session_clock::tests::accepted,
        transcription::{AudioChunk, Recognized},
    };
    use objc2_core_media::{CMTime, CMTimeFlags};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    };

    const WAIT: Duration = Duration::from_secs(5);

    /// The memory-only clock feed plus a scripted owner: Running until the
    /// operation is cancelled, two polls of Stopping, then the capture is
    /// released. With `stop_fails`, Stop reports failure until one retry.
    /// Owner completion ordering has its own tests.
    struct Scripted {
        feed: Feed,
        control: Control,
        capture: Option<Capture<()>>,
        stopping: u8,
        stop_fails: bool,
        retries: Arc<AtomicU64>,
        /// Another operation's feed, read first, with its running capture.
        foreign: Option<(Feed, Capture<()>)>,
        /// Fail on the second poll, as an unexpected fault in the loop would.
        panics: bool,
        /// Polls so far, and the number of the first poll that found the
        /// operation cancelled (zero until then).
        polls: Arc<AtomicU64>,
        first_cancelled_poll: Arc<AtomicU64>,
        /// Fail rather than poll forever if nothing cancels the operation.
        poll_limit: u64,
    }

    impl Source for Scripted {
        fn poll(&mut self) -> Status {
            if self.panics && std::mem::replace(&mut self.stopping, 1) == 1 {
                panic!("fictional fault in the source worker");
            }
            let poll = self.polls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.control.is_cancelled() {
                let _ = self.first_cancelled_poll.compare_exchange(
                    0,
                    poll,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
            } else {
                assert!(
                    poll <= self.poll_limit,
                    "still not cancelled after {poll} polls"
                );
            }
            let stage = if self.capture.is_none() {
                Stage::Released
            } else if !self.control.is_cancelled() {
                Stage::Running
            } else if self.stop_fails {
                // Bounded, so a retry that never arrives fails the test.
                self.stopping += 1;
                assert!(self.stopping < 250, "the failed Stop was never retried");
                Stage::StopFailed
            } else if self.stopping < 2 {
                self.stopping += 1;
                Stage::Stopping
            } else {
                self.capture = None;
                Stage::Released
            };
            Status {
                stage,
                problem: None,
            }
        }

        fn retry_cleanup(&mut self) -> bool {
            self.retries.fetch_add(1, Ordering::SeqCst);
            self.stopping = 0;
            std::mem::take(&mut self.stop_fails)
        }

        fn try_next(&mut self, session: u64) -> Result<Option<NativeBlock>, TimingError> {
            if let Some((feed, _)) = &mut self.foreign {
                if let Some(block) = feed.next(session)? {
                    return Ok(Some(block));
                }
            }
            self.feed.next(session)
        }
    }

    /// Reports each call. With `release`, waits from the second call on, so a
    /// test can act while the recognizer holds the second chunk.
    struct Recognizer {
        calls: u64,
        started: mpsc::Sender<u64>,
        release: Option<mpsc::Receiver<()>>,
    }

    impl Transcriber for Recognizer {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            self.calls += 1;
            let _ = self.started.send(self.calls);
            if let Some(release) = self.release.as_ref().filter(|_| self.calls >= 2) {
                let _ = release.recv_timeout(WAIT);
            }
            Ok(vec![Recognized {
                offset_ms: 100,
                speaker: "Speaker 1".into(),
                text: format!("Fictional line {}.", self.calls),
            }])
        }
    }

    struct Fixture {
        runtime: Arc<Mutex<Runtime>>,
        session: u64,
        gate: Gate,
        control: Control,
        start: Option<Start>,
        input: Input,
        reader: Option<crate::application_audio::handoff::Reader>,
    }

    fn fixture() -> Fixture {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
        drop(ticket);
        let session = runtime.engine.session();
        let gate = Gate::default();
        let mut review = gate
            .review(Application::new("fictional".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let control = review.control();
        let mut start = gate.approve(&mut review).unwrap();
        assert!(start.control().same_operation(&control));
        let (input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 32).unwrap();
        Fixture {
            runtime: Arc::new(Mutex::new(runtime)),
            session,
            gate,
            control,
            start: Some(start),
            input,
            reader: Some(reader),
        }
    }

    impl Fixture {
        /// Two chunks separated by a real gap, then a few frames that stay
        /// pending. Ten 2,048-frame blocks are 1,280 ms of fictional audio.
        fn queue_audio(&mut self) {
            let mut frame = 0;
            for run in 0..3 {
                for _ in 0..(if run == 2 { 1 } else { 10 }) {
                    self.input
                        .push(&self.control, frame, &[0.25; 2_048])
                        .unwrap();
                    frame += 2_048;
                }
                frame += 16_000; // One second is missing here.
            }
        }

        fn scripted(&mut self, binding: ClockBinding) -> Scripted {
            let capture = self.start.take().unwrap().run(|_, _| Ok(())).unwrap();
            Scripted {
                feed: Feed::new(self.reader.take().unwrap(), binding, 1.0),
                control: self.control.clone(),
                capture: Some(capture),
                stopping: 0,
                stop_fails: false,
                retries: Arc::default(),
                foreign: None,
                panics: false,
                polls: Arc::default(),
                first_cancelled_poll: Arc::default(),
                poll_limit: u64::MAX,
            }
        }

        fn transcript(&self) -> Vec<(u64, String)> {
            let runtime = self.runtime.lock().unwrap();
            runtime
                .engine
                .state
                .transcript
                .iter()
                .map(|line| (line.at_ms, line.text.clone()))
                .collect()
        }

        /// Let the session clock pass the queued audio, so a line is not
        /// refused merely for being ahead of the engine.
        fn advance(&self) {
            let mut runtime = self.runtime.lock().unwrap();
            let later = runtime.last_tick + Duration::from_secs(10);
            runtime.sync_at(later);
        }
    }

    /// Ends the pump if the host thread fails or the path under test never
    /// cancels the source, so a broken test fails instead of hanging.
    struct Watchdog(Control);
    impl Watchdog {
        fn expect_cancelled(self) {
            let deadline = std::time::Instant::now() + WAIT;
            while !self.0.is_cancelled() && std::time::Instant::now() < deadline {
                thread::sleep(Duration::from_millis(2));
            }
            assert!(self.0.is_cancelled(), "the source was never cancelled");
        }
    }
    impl Drop for Watchdog {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }

    /// Runs `host` on another thread once the recognizer holds the second
    /// chunk, releases the recognizer afterwards, and returns the report.
    fn pump_while(
        fixture: &mut Fixture,
        source: Scripted,
        monitor: Monitor,
        host: impl FnOnce() + Send + 'static,
    ) -> Report {
        let (started, calls) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let watchdog = Watchdog(fixture.control.clone());
        let host = thread::spawn(move || {
            assert_eq!(calls.recv_timeout(WAIT), Ok(1));
            // The worker is single-threaded: the first chunk's line has been
            // through the sink before the recognizer is called again.
            assert_eq!(calls.recv_timeout(WAIT), Ok(2));
            host();
            release.send(()).unwrap();
            watchdog.expect_cancelled();
        });
        let recognizer = Recognizer {
            calls: 0,
            started,
            release: Some(released),
        };
        let runtime = fixture.runtime.clone();
        let report = pump_with(fixture, runtime, source, recognizer, monitor);
        host.join().unwrap();
        report
    }

    /// Runs the pump with an ungated recognizer until the pump itself ends.
    fn pump_alone<A: Access>(fixture: &mut Fixture, runtime: A, source: Scripted) -> Report {
        let (started, _calls) = mpsc::channel();
        let recognizer = Recognizer {
            calls: 0,
            started,
            release: None,
        };
        pump_alone_with(fixture, runtime, source, recognizer)
    }

    fn pump_alone_with<A: Access>(
        fixture: &mut Fixture,
        runtime: A,
        source: Scripted,
        transcriber: impl Transcriber,
    ) -> Report {
        let watchdog = Watchdog(fixture.control.clone());
        let host = thread::spawn(move || watchdog.expect_cancelled());
        let report = pump_with(fixture, runtime, source, transcriber, Monitor::default());
        host.join().unwrap();
        report
    }

    /// The worker and loop exactly as `run` joins them, after its native step.
    fn pump_with<A: Access>(
        fixture: &Fixture,
        runtime: A,
        source: Scripted,
        transcriber: impl Transcriber,
        monitor: Monitor,
    ) -> Report {
        let worker = start_worker(
            runtime.clone(),
            fixture.session,
            &fixture.control,
            transcriber,
        );
        pump(
            runtime,
            fixture.session,
            fixture.control.clone(),
            source,
            worker,
            Duration::ZERO,
            monitor,
        )
    }

    fn unattached(fixture: &Fixture) -> ClockBinding {
        // The same numbers an accepted binding would hold, built directly:
        // the reader, chunks and worker all run, but nothing was attached.
        let host_time = CMTime {
            value: 7,
            timescale: 1,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        };
        ClockBinding::new(fixture.session, host_time, Duration::ZERO).unwrap()
    }

    fn attach(fixture: &Fixture) -> ClockBinding {
        let mut runtime = fixture.runtime.lock().unwrap();
        accepted(&mut runtime, &fixture.control).unwrap().binding
    }

    #[test]
    fn an_attached_source_reaches_the_engine_until_the_session_stops_or_ends() {
        for ended in [false, true] {
            let mut fixture = fixture();
            let binding = attach(&fixture);
            fixture.advance();
            fixture.queue_audio();
            let (runtime, before) = (fixture.runtime.clone(), fixture.transcript());
            assert!(before.is_empty());
            let source = fixture.scripted(binding);
            let report = pump_while(&mut fixture, source, Monitor::default(), move || {
                let mut runtime = runtime.lock().unwrap();
                assert_eq!(runtime.engine.state.transcript.len(), 1);
                if ended {
                    // The session ends without the Stop step or a sync. The
                    // engine refuses the late line by itself; what this arm
                    // shows is that the sink's sync retires the still-running
                    // source, which is the only thing that ends the pump.
                    runtime.engine.end();
                } else {
                    drop(runtime.take_live_for_stop().unwrap());
                }
            });
            // The first sample is 1 µs into the session and the recognizer
            // placed its line 100 ms into the chunk.
            assert_eq!(
                fixture.transcript(),
                [(100, "Fictional line 1.".to_string())],
                "ended {ended}"
            );
            assert_eq!(report.status.stage, Stage::Released);
            assert_eq!(report.worker.accepted, 1);
            // Stop cancels the source, so the held chunk's line is withheld
            // before the sink. An ended session leaves the source running
            // until the sink refuses the line and retires it.
            assert_eq!(report.worker.rejected, u64::from(ended));
            assert!(fixture.control.is_cancelled());
            assert_eq!(fixture.gate.snapshot().unwrap().phase, Phase::Idle);
        }
    }

    #[test]
    fn a_source_without_an_accepted_clock_cannot_put_a_line_in_the_engine() {
        let mut fixture = fixture();
        let binding = unattached(&fixture);
        fixture.advance();
        fixture.queue_audio();
        let source = fixture.scripted(binding);
        let runtime = fixture.runtime.clone();
        // Nobody stops it: the refusal of its first line is what ends it.
        let report = pump_alone(&mut fixture, runtime, source);
        assert!(fixture.transcript().is_empty());
        assert_eq!(
            (
                report.worker.chunks,
                report.worker.accepted,
                report.worker.rejected
            ),
            (1, 0, 1),
            "recognized once, refused at the sink, then no more inference"
        );
        assert!(fixture.control.is_cancelled());
        assert_eq!(report.status.stage, Stage::Released);
        // The running live session was not disturbed.
        assert!(fixture
            .runtime
            .lock()
            .unwrap()
            .live_source_operation()
            .is_some());
    }

    #[test]
    fn a_silent_unattached_source_is_stopped_at_the_first_attachment_check() {
        // Counted in passes, with no parking and no watchdog, so the result
        // does not depend on how fast or busy the machine is. The app's own
        // interval is one of the cases.
        for every in [ATTACHED_EVERY, 3] {
            let mut fixture = fixture();
            let binding = unattached(&fixture);
            let mut source = fixture.scripted(binding);
            source.poll_limit = 10 * u64::from(every);
            let (polls, first_cancelled) =
                (source.polls.clone(), source.first_cancelled_poll.clone());
            let worker = start_worker(
                fixture.runtime.clone(),
                fixture.session,
                &fixture.control,
                Silent,
            );
            let report = pump_paced(
                fixture.runtime.clone(),
                fixture.session,
                fixture.control.clone(),
                source,
                worker,
                Duration::ZERO,
                Monitor::default(),
                Pace {
                    poll: Duration::ZERO,
                    attached_every: every,
                },
            );
            // Pass `every` asks the runtime and cancels; the next poll is the
            // first to see it. Not one pass sooner or later.
            assert_eq!(
                first_cancelled.load(Ordering::SeqCst),
                u64::from(every) + 1,
                "every {every}"
            );
            assert_eq!(report.status.stage, Stage::Released);
            assert_eq!((report.worker.chunks, report.worker.rejected), (0, 0));
            assert!(fixture.control.is_cancelled());
            // Two polls of stopping, then released.
            assert_eq!(polls.load(Ordering::SeqCst), u64::from(every) + 3);
        }
    }

    struct Silent;
    impl Transcriber for Silent {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            Ok(Vec::new())
        }
    }

    struct Crashes;
    impl Transcriber for Crashes {
        fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
            panic!("fictional recognizer failure");
        }
    }

    #[test]
    fn a_dead_transcription_worker_stops_the_source() {
        let mut fixture = fixture();
        let binding = attach(&fixture);
        fixture.queue_audio();
        let source = fixture.scripted(binding);
        let runtime = fixture.runtime.clone();
        let report = pump_alone_with(&mut fixture, runtime, source, Crashes);
        assert_eq!(report.status.stage, Stage::Released);
        assert!(fixture.control.is_cancelled());
        assert!(fixture.transcript().is_empty());
    }

    #[test]
    fn a_worker_that_ends_without_release_is_shown_as_abandoned_not_stopped() {
        let mut fixture = fixture();
        let binding = attach(&fixture);
        let mut source = fixture.scripted(binding);
        source.panics = true;
        let monitor = Monitor::default();
        assert!(!monitor.abandoned());
        let runtime = fixture.runtime.clone();
        let (seen, shared) = (monitor.clone(), &fixture);
        let ended = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            pump_with(shared, runtime, source, Crashes, seen)
        }));
        assert!(ended.is_err());
        assert!(monitor.abandoned());
        assert!(fixture.control.is_cancelled(), "delivery is closed");
        // The last stage seen was not Released, and no retry is accepted.
        assert_ne!(monitor.status().map(|s| s.stage), Some(Stage::Released));
        assert!(!monitor.retry_cleanup());
    }

    #[test]
    fn a_failed_native_stop_stays_visible_and_reserved_until_one_explicit_retry() {
        let mut fixture = fixture();
        let binding = attach(&fixture);
        fixture.advance();
        fixture.queue_audio();
        let mut source = fixture.scripted(binding);
        source.stop_fails = true;
        let retries = source.retries.clone();
        let monitor = Monitor::default();
        assert!(!monitor.retry_cleanup(), "nothing has failed yet");
        let (runtime, gate, watch) = (
            fixture.runtime.clone(),
            fixture.gate.clone(),
            monitor.clone(),
        );
        let report = pump_while(&mut fixture, source, monitor, move || {
            assert_eq!(watch.status().map(|s| s.stage), Some(Stage::Running));
            assert!(!watch.retry_cleanup(), "a retry is not saved for later");
            drop(runtime.lock().unwrap().take_live_for_stop().unwrap());
            let deadline = std::time::Instant::now() + WAIT;
            while watch.status().map(|s| s.stage) != Some(Stage::StopFailed) {
                assert!(std::time::Instant::now() < deadline, "failure not shown");
                thread::sleep(Duration::from_millis(2));
            }
            // Several polls later it is still failed, never retried by
            // itself, and the gate still refuses another source.
            thread::sleep(Duration::from_millis(100));
            assert_eq!(watch.status().map(|s| s.stage), Some(Stage::StopFailed));
            assert_eq!(retries.load(Ordering::SeqCst), 0);
            assert_eq!(gate.snapshot().unwrap().phase, Phase::Capturing);
            assert!(watch.retry_cleanup());
            assert!(!watch.retry_cleanup(), "one request at a time");
            while retries.load(Ordering::SeqCst) == 0 {
                assert!(std::time::Instant::now() < deadline, "retry not performed");
                thread::sleep(Duration::from_millis(1));
            }
            // The retry was performed. The failure the host saw is spent: a
            // second request needs a newly observed failure.
            assert!(!watch.retry_cleanup());
            thread::sleep(Duration::from_millis(100));
            assert!(!watch.retry_cleanup());
            assert_eq!(retries.load(Ordering::SeqCst), 1);
        });
        assert_eq!(report.status.stage, Stage::Released);
        assert_eq!(fixture.gate.snapshot().unwrap().phase, Phase::Idle);
    }

    #[test]
    fn the_end_of_input_cancels_the_source_and_leaves_pending_audio_unrecognized() {
        let mut fixture = fixture();
        let binding = attach(&fixture);
        fixture.advance();
        fixture.queue_audio();
        let source = fixture.scripted(binding);
        // The producer goes away cleanly. The reader retires on the closed
        // input and that retirement is what cancels the operation here.
        let (silent, _reader) = {
            let gate = Gate::default();
            let mut review = gate
                .review(Application::new("spare".into(), "Fictional player".into()).unwrap())
                .unwrap();
            gate.approve(&mut review)
                .unwrap()
                .handoff(Format::new(16_000, 1).unwrap(), 1)
                .unwrap()
        };
        drop(std::mem::replace(&mut fixture.input, silent));
        let runtime = fixture.runtime.clone();
        let report = pump_alone(&mut fixture, runtime, source);
        assert_eq!(report.status.stage, Stage::Released);
        assert!(fixture.control.is_cancelled());
        // Two chunks were complete; the trailing block was never flushed to
        // the recognizer, and nothing arrives once the pump has returned.
        assert!(report.worker.chunks <= 2);
        assert!(fixture.transcript().len() <= 2);
        assert!(fixture
            .transcript()
            .iter()
            .all(|(at_ms, _)| *at_ms == 100 || *at_ms == 100 + 1_280 + 1_000));
    }

    #[test]
    fn a_block_the_chunker_refuses_stops_the_source_it_was_read_for() {
        let mut fixture = fixture();
        let binding = attach(&fixture);
        fixture.queue_audio();
        let mut source = fixture.scripted(binding);
        // One valid block of the same session from a different operation.
        // The reader that produced it sees nothing wrong; only the chunker,
        // bound to this worker's source, refuses it.
        let other_gate = Gate::default();
        let mut review = other_gate
            .review(Application::new("other".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let other = review.control();
        let mut start = other_gate.approve(&mut review).unwrap();
        let (mut input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 1).unwrap();
        let capture = start.run(|_, _| Ok(())).unwrap();
        input.push(&other, 0, &[0.25; 2_048]).unwrap();
        let binding = unattached(&fixture);
        source.foreign = Some((Feed::new(reader, binding, 1.0), capture));
        let runtime = fixture.runtime.clone();
        let report = pump_alone(&mut fixture, runtime, source);
        assert_eq!(report.status.stage, Stage::Released);
        assert!(fixture.control.is_cancelled());
        assert_eq!(report.worker.chunks, 0, "its own queued audio is not read");
        assert!(fixture.transcript().is_empty());
    }

    #[derive(Clone)]
    struct Unavailable;
    impl Access for Unavailable {
        fn with<R>(&self, _: impl FnOnce(&mut Runtime) -> R) -> Option<R> {
            None
        }
    }

    #[test]
    fn an_unavailable_runtime_stops_the_source_instead_of_listening_for_nothing() {
        let mut fixture = fixture();
        let binding = attach(&fixture);
        fixture.queue_audio();
        let source = fixture.scripted(binding);
        let report = pump_alone(&mut fixture, Unavailable, source);
        assert_eq!(report.status.stage, Stage::Released);
        assert!(fixture.control.is_cancelled());
        assert_eq!(report.worker.accepted, 0);
        assert!(fixture.transcript().is_empty());
    }

    #[test]
    fn preparing_attaches_one_source_and_refuses_a_second_or_a_stopped_session() {
        let first = fixture();
        let runtime = first.runtime.clone();
        // A real host-clock read; no stream, device or permission is involved.
        let measure = |snapshot: Snapshot| snapshot.measure(WAIT, WAIT);
        let prepared = prepare(&runtime, &first.control, measure).unwrap();
        assert_eq!(prepared.session, first.session);
        assert!(runtime
            .lock()
            .unwrap()
            .live_source_accepts(first.session, &first.control));

        let other_gate = Gate::default();
        let other = other_gate
            .review(Application::new("other".into(), "Fictional player".into()).unwrap())
            .unwrap();
        assert_eq!(
            prepare(&runtime, &other.control(), measure).err(),
            Some(TimingError::Occupied)
        );
        assert!(!first.control.is_cancelled() && !other.control().is_cancelled());

        let stopped = runtime.lock().unwrap().take_live_for_stop();
        drop(stopped.unwrap());
        assert!(first.control.is_cancelled());
        assert_eq!(
            prepare(&runtime, &other.control(), |_| panic!("no clock read")).err(),
            Some(TimingError::SessionChanged)
        );
    }
}
