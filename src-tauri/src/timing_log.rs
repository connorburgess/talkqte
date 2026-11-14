//! Development-only timing log for lab runs with fictional audio.
//!
//! Only a build with the `timing-log` Cargo feature contains the code that
//! opens and writes the log; in any other build `enabled` is false and every
//! entry point does nothing. With the feature, the log is written only while
//! `TALKQTE_TIMING_LOG` names an absolute file path outside this checkout.
//! One JSON object per line is then appended to that file, and nothing is
//! sent anywhere. One process writes one file: two app instances must not
//! share a path.
//!
//! Recording never runs in an audio callback. Events come from the
//! transcription runner, the application-source worker and the runtime, and
//! recording only formats a line and hands it to a writer thread without
//! waiting. The writer thread opens the file, so a slow or stalled volume
//! cannot hold up the caller. A full queue or a failed write drops the line
//! and counts it; the writer reports the count before its next line.

use crate::engine::{Cue, Engine, Segment, Status, CONTEXT, STILL_OPEN};
use crate::Runtime;
use serde::Serialize;
#[cfg(feature = "timing-log")]
use std::{
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex, OnceLock,
    },
    thread::JoinHandle,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// The environment variable naming the log file.
pub const ENV: &str = "TALKQTE_TIMING_LOG";
#[cfg(feature = "timing-log")]
const QUEUE: usize = 1024;

/// One timed event. Times named `*_ms` without `wall` or `mono` are on the
/// engine's session clock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// A session started or ended, with its clock at that moment. Anchors
    /// session time to wall time.
    Session {
        session: u64,
        live: bool,
        state: &'static str,
        elapsed_ms: u64,
        /// The commit this build came from, if the build was told it.
        commit: &'static str,
        /// The Cargo features compiled in.
        features: Vec<&'static str>,
    },
    /// A chunk of audio handed to the transcription queue. Written when it
    /// is queued, not when the sound was played; `start_ms` is when its
    /// first sample falls on the session clock.
    AudioReceived {
        source: &'static str,
        session: u64,
        start_ms: u64,
        duration_ms: u64,
        /// Some sample reaches about -60 dBFS: the chunk is not silence.
        audible: bool,
    },
    /// A recognized line reaching the engine, and whether it was accepted.
    Segment {
        session: u64,
        id: String,
        at_ms: u64,
        speaker: String,
        text: String,
        accepted: bool,
    },
    /// The engine first holds a cue. `question` and `source_id` are written
    /// only for a phrase cue raised by a transcript line, where `source_id`
    /// is that line. A model cue has `source` `evaluated`, the first line it
    /// cites as `source_id`, and no question. A cue that quotes a note, lists
    /// focus lines or concerns the focus has `source` `note` or `focus` and no
    /// question, so neither note titles nor focus lines reach the log.
    ///
    /// `decider` is `phrase_rule` or `model`. A model cue is recorded where
    /// the engine accepts the evaluator's reply, with its `request`.
    CueDecision {
        session: u64,
        cue: String,
        kind: String,
        source: &'static str,
        decider: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        request: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        question: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
        elapsed_ms: u64,
    },
    /// The model connection was turned on or off.
    Evaluator {
        session: u64,
        state: &'static str,
        backend: String,
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        elapsed_ms: u64,
    },
    /// A request was sent to the evaluator. Ids and counts only.
    EvaluationRequested {
        session: u64,
        request: u64,
        /// The newest transcript line the request covers, as `segment.id`.
        through_segment: String,
        lines: usize,
        has_cue: bool,
        elapsed_ms: u64,
    },
    /// What came back: `show`, `quiet`, `resolved`, `withdraw`, `failed`,
    /// `stale` or `cancelled`, with a fixed failure code when it failed.
    EvaluationResult {
        session: u64,
        request: u64,
        outcome: &'static str,
        latency_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        failure: Option<&'static str>,
        elapsed_ms: u64,
    },
    /// A cue is in the snapshot sent to the companion window. The log cannot
    /// see when the window paints it.
    CuePublished {
        session: u64,
        cue: String,
        elapsed_ms: u64,
    },
    /// That cue is no longer in the snapshot sent to the companion window.
    CueCleared {
        session: u64,
        cue: String,
        elapsed_ms: u64,
    },
    /// Lines lost since the last line written, because the queue was full
    /// or a write failed.
    Dropped { count: u64 },
}

/// The line written for `event`: its fields plus wall and monotonic times.
pub fn line(event: &Event, wall_ms: u64, mono_ms: u64) -> String {
    let mut value = serde_json::to_value(event).expect("timing events serialize");
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("wall_ms".into(), wall_ms.into());
        map.insert("mono_ms".into(), mono_ms.into());
    }
    value.to_string()
}

#[cfg(feature = "timing-log")]
fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(feature = "timing-log")]
fn since(opened: Instant) -> u64 {
    u64::try_from(opened.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// The repository this build came from. Lab output stays outside it.
#[cfg(feature = "timing-log")]
fn checkout() -> &'static Path {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap_or(manifest)
}

/// Refuse a path that is relative, climbs with `..`, or names somewhere in
/// `checkout`, by its text. The writer checks again once links are resolved.
#[cfg(feature = "timing-log")]
fn allowed(path: &Path, checkout: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("The timing log path must be absolute.".into());
    }
    if path.components().any(|part| part == Component::ParentDir) {
        return Err("The timing log path must not contain \"..\".".into());
    }
    if path.starts_with(checkout) {
        return Err("The timing log path is inside the repository.".into());
    }
    Ok(())
}

/// Open `path` for appending, readable by its owner only. Runs on the writer
/// thread. Refuses a folder inside `checkout` once links are resolved, a link,
/// and anything that is not a regular file, so a pipe cannot be opened.
#[cfg(feature = "timing-log")]
fn open_file(path: &Path, checkout: &Path) -> io::Result<std::fs::File> {
    let refuse = |why: &str| io::Error::other(why.to_string());
    let folder = path
        .parent()
        .ok_or_else(|| refuse("no folder"))?
        .canonicalize()?;
    if let Ok(checkout) = checkout.canonicalize() {
        if folder.starts_with(checkout) {
            return Err(refuse("inside the repository"));
        }
    }
    match std::fs::symlink_metadata(path) {
        Ok(existing) if !existing.file_type().is_file() => {
            return Err(refuse("not a regular file"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW: a link swapped in after the check is not followed.
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// A log and its writer thread.
#[cfg(feature = "timing-log")]
pub struct Log {
    sender: Option<SyncSender<String>>,
    dropped: Arc<AtomicU64>,
    opened: Instant,
    writer: Option<JoinHandle<()>>,
}

#[cfg(feature = "timing-log")]
impl Log {
    /// Append to `path`, which must be absolute and outside this repository.
    /// Its folder must exist: nothing else is created. The file is opened on
    /// the writer thread, which says on stderr whether it opened.
    pub fn open(path: &Path, capacity: usize) -> Result<Self, String> {
        allowed(path, checkout())?;
        let path: PathBuf = path.to_path_buf();
        Self::start(capacity, move || open_file(&path, checkout()))
    }

    /// Start a writer that gets its output from `opener`, on its own thread.
    fn start<W, F>(capacity: usize, opener: F) -> Result<Self, String>
    where
        W: Write,
        F: FnOnce() -> io::Result<W> + Send + 'static,
    {
        let opened = Instant::now();
        let (sender, receiver) = sync_channel::<String>(capacity.max(1));
        let dropped = Arc::new(AtomicU64::new(0));
        let lost = dropped.clone();
        let writer = std::thread::Builder::new()
            .name("talkqte-timing-log".into())
            .spawn(move || {
                let Ok(mut out) = opener() else {
                    eprintln!("TalkQTE timing log: could not open the file named by {ENV}; nothing will be written.");
                    return;
                };
                eprintln!("TalkQTE timing log: on, appending to the file named by {ENV}.");
                // One write per line, newline included, so a line is never
                // split by a failure between its text and its newline.
                let mut put = |text: String| {
                    let mut entry = text.into_bytes();
                    entry.push(b'\n');
                    out.write_all(&entry).and_then(|()| out.flush()).is_ok()
                };
                let report = |lost: &AtomicU64, put: &mut dyn FnMut(String) -> bool| {
                    let missed = lost.swap(0, Ordering::AcqRel);
                    if missed > 0 {
                        let marker = line(&Event::Dropped { count: missed }, wall_ms(), since(opened));
                        if !put(marker) {
                            lost.fetch_add(missed, Ordering::AcqRel);
                        }
                    }
                };
                for entry in receiver {
                    report(&lost, &mut put);
                    if !put(entry) {
                        lost.fetch_add(1, Ordering::AcqRel);
                    }
                }
                // The queue closed: report anything lost after the last line.
                report(&lost, &mut put);
            })
            .map_err(|_| "Could not start the timing log.".to_string())?;
        Ok(Self {
            sender: Some(sender),
            dropped,
            opened,
            writer: Some(writer),
        })
    }

    /// Stamp and queue one event without waiting.
    pub fn record(&self, event: &Event) {
        let line = line(event, wall_ms(), since(self.opened));
        let sent = self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.try_send(line).is_ok());
        if !sent {
            self.dropped.fetch_add(1, Ordering::AcqRel);
        }
    }
}

#[cfg(feature = "timing-log")]
impl Drop for Log {
    fn drop(&mut self) {
        // Close the queue, then let the writer finish what it holds.
        self.sender.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

#[cfg(feature = "timing-log")]
fn global() -> Option<&'static Log> {
    static LOG: OnceLock<Option<Log>> = OnceLock::new();
    LOG.get_or_init(|| {
        let path = std::env::var_os(ENV)?;
        match Log::open(Path::new(&path), QUEUE) {
            Ok(log) => Some(log),
            Err(why) => {
                eprintln!("TalkQTE timing log: off. {why}");
                None
            }
        }
    })
    .as_ref()
}

/// Whether events are being recorded. Always false without the
/// `timing-log` feature.
pub fn enabled() -> bool {
    #[cfg(feature = "timing-log")]
    return global().is_some();
    #[cfg(not(feature = "timing-log"))]
    false
}

/// Record one event, if the log is on. Check `enabled` first to avoid
/// building an event that would be thrown away.
pub fn record(event: Event) {
    #[cfg(feature = "timing-log")]
    if let Some(log) = global() {
        log.record(&event);
    }
    #[cfg(not(feature = "timing-log"))]
    drop(event);
}

/// Peak level, as a fraction of full scale, above which a chunk counts as
/// audible: about -60 dBFS.
pub const AUDIBLE: f32 = 0.001;

/// The event for mono 16 kHz `samples` handed to transcription.
pub fn audio_event(source: &'static str, session: u64, start_ms: u64, samples: &[f32]) -> Event {
    let rate = crate::transcription::SAMPLE_RATE as u64;
    Event::AudioReceived {
        source,
        session,
        start_ms,
        duration_ms: samples.len() as u64 * 1_000 / rate,
        audible: samples.iter().any(|sample| sample.abs() >= AUDIBLE),
    }
}

/// Record a chunk handed to transcription. Called on the runner or source
/// worker, never in an audio callback.
pub fn record_audio(source: &'static str, session: u64, start_ms: u64, samples: &[f32]) {
    if enabled() {
        record(audio_event(source, session, start_ms, samples));
    }
}

/// The commit, from `TALKQTE_COMMIT` at build time, or "unknown".
pub fn commit() -> &'static str {
    option_env!("TALKQTE_COMMIT").unwrap_or("unknown")
}

/// The Cargo features this build has, among those that change capture.
pub fn features() -> Vec<&'static str> {
    [
        ("local-whisper", cfg!(feature = "local-whisper")),
        ("native-audio-spike", cfg!(feature = "native-audio-spike")),
        ("timing-log", cfg!(feature = "timing-log")),
        ("claude-cli", cfg!(feature = "claude-cli")),
    ]
    .into_iter()
    .filter_map(|(name, on)| on.then_some(name))
    .collect()
}

/// The decision event for `cue`. Only a phrase cue raised by a transcript
/// line, and not about the focus, keeps its question and source line: its
/// question is a fixed phrase or quotes the line, which the log already has.
pub fn decision(session: u64, cue: &Cue, elapsed_ms: u64) -> Event {
    // Phrase rules ask fixed questions or quote the line itself. A cue
    // from a note, the focus lines or an evaluator is left out.
    let source = if cue.note.is_some() || cue.kind == CONTEXT {
        "note"
    } else if cue.about_focus || cue.kind == STILL_OPEN {
        "focus"
    } else if !cue.sources.is_empty() {
        "evaluated"
    } else {
        "line"
    };
    let line = source == "line";
    Event::CueDecision {
        session,
        cue: cue.id.clone(),
        kind: cue.kind.clone(),
        source,
        decider: "phrase_rule",
        request: None,
        question: line.then(|| cue.question.clone()),
        source_id: line.then(|| cue.source_id.clone()),
        elapsed_ms,
    }
}

/// The events for one line reaching the engine: the line itself and, if the
/// engine now holds a cue it did not hold before, that decision.
pub fn ingest_events(
    session: u64,
    segment: &Segment,
    accepted: bool,
    before: Option<&str>,
    after: Option<&Cue>,
    elapsed_ms: u64,
) -> Vec<Event> {
    let mut events = vec![Event::Segment {
        session,
        id: segment.id.clone(),
        at_ms: segment.at_ms,
        speaker: segment.speaker.clone(),
        text: segment.text.clone(),
        accepted,
    }];
    // A model cue is recorded by the engine where it accepts the reply.
    if let Some(cue) = after.filter(|cue| Some(cue.id.as_str()) != before && cue.sources.is_empty())
    {
        events.push(decision(session, cue, elapsed_ms));
    }
    events
}

/// What the companion was last sent: the session, whether it was running,
/// and the cue it showed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shown {
    pub session: u64,
    pub running: bool,
    pub cue: Option<String>,
}

impl Shown {
    pub fn of(engine: &Engine) -> Self {
        Self {
            session: engine.session(),
            running: engine.state.status == Status::Running,
            cue: engine.state.cue.as_ref().map(|cue| cue.id.clone()),
        }
    }
}

/// Events between two published snapshots: a session that stopped running
/// or started, a cue that left, and a cue that arrived, in that order.
pub fn shown_events(before: &Shown, after: &Shown, live: bool, elapsed_ms: u64) -> Vec<Event> {
    let session_event = |session, state| Event::Session {
        session,
        live,
        state,
        elapsed_ms,
        commit: commit(),
        features: features(),
    };
    let mut events = Vec::new();
    let same_session = before.session == after.session;
    if before.running && (!same_session || !after.running) {
        events.push(session_event(before.session, "ended"));
    }
    if before.cue != after.cue || !same_session {
        if let Some(cue) = &before.cue {
            events.push(Event::CueCleared {
                session: before.session,
                cue: cue.clone(),
                elapsed_ms,
            });
        }
    }
    if after.running && (!same_session || !before.running) {
        events.push(session_event(after.session, "started"));
    }
    if before.cue != after.cue || !same_session {
        if let Some(cue) = &after.cue {
            events.push(Event::CuePublished {
                session: after.session,
                cue: cue.clone(),
                elapsed_ms,
            });
        }
    }
    events
}

/// Called each time the companion is sent a snapshot.
pub fn observe_published(engine: &Engine) {
    #[cfg(feature = "timing-log")]
    if let Some(log) = global() {
        static LAST: Mutex<Option<Shown>> = Mutex::new(None);
        let now = Shown::of(engine);
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let before = last.clone().unwrap_or_default();
        for event in shown_events(&before, &now, engine.state.live, engine.state.elapsed_ms) {
            log.record(&event);
        }
        *last = Some(now);
    }
    #[cfg(not(feature = "timing-log"))]
    let _ = engine;
}

impl Runtime {
    /// `Engine::ingest`, recording the line and any cue it raised while the
    /// timing log is on. Behaves exactly like `Engine::ingest` otherwise.
    /// Its callers are the live sinks, which only some builds compile.
    #[cfg_attr(
        not(any(
            feature = "local-whisper",
            all(target_os = "macos", feature = "native-audio-spike"),
            test
        )),
        allow(dead_code)
    )]
    pub(crate) fn ingest_timed(&mut self, session: u64, segment: Segment) -> Result<(), String> {
        #[cfg(feature = "timing-log")]
        return self.ingest_into(global(), session, segment);
        #[cfg(not(feature = "timing-log"))]
        self.engine.ingest(session, segment)
    }

    #[cfg(feature = "timing-log")]
    fn ingest_into(
        &mut self,
        log: Option<&Log>,
        session: u64,
        segment: Segment,
    ) -> Result<(), String> {
        let Some(log) = log else {
            return self.engine.ingest(session, segment);
        };
        let line = segment.clone();
        let before = self.engine.state.cue.as_ref().map(|cue| cue.id.clone());
        let result = self.engine.ingest(session, segment);
        for event in ingest_events(
            session,
            &line,
            result.is_ok(),
            before.as_deref(),
            self.engine.state.cue.as_ref(),
            self.engine.state.elapsed_ms,
        ) {
            log.record(&event);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_events_carry_ids_and_codes_but_no_prompt_or_reply() {
        let lines: Vec<serde_json::Value> = [
            Event::Evaluator {
                session: 3,
                state: "on",
                backend: "claude-cli".into(),
                model: "claude-opus-5-5".into(),
                effort: Some("medium".into()),
                elapsed_ms: 100,
            },
            Event::EvaluationRequested {
                session: 3,
                request: 1,
                through_segment: "w4".into(),
                lines: 4,
                has_cue: false,
                elapsed_ms: 200,
            },
            Event::EvaluationResult {
                session: 3,
                request: 1,
                outcome: "failed",
                latency_ms: 8_000,
                failure: Some("timeout"),
                elapsed_ms: 8_200,
            },
        ]
        .iter()
        .map(|event| serde_json::from_str(&line(event, 1, 2)).unwrap())
        .collect();
        assert_eq!(lines[0]["event"], "evaluator");
        assert_eq!(lines[1]["event"], "evaluation_requested");
        assert_eq!(lines[1]["through_segment"], "w4");
        assert_eq!(lines[2]["event"], "evaluation_result");
        assert_eq!(lines[2]["failure"], "timeout");
        for value in &lines {
            assert_eq!(value["wall_ms"], 1);
            assert_eq!(value["mono_ms"], 2);
            assert!(value.get("text").is_none() && value.get("prompt").is_none());
        }
    }
    use serde_json::Value;

    #[test]
    fn a_default_build_never_turns_the_log_on() {
        if !cfg!(feature = "timing-log") {
            assert!(!enabled());
            record(Event::CueCleared {
                session: 1,
                cue: "fictional".into(),
                elapsed_ms: 0,
            });
            assert!(!enabled());
        }
        assert_eq!(
            features().contains(&"timing-log"),
            cfg!(feature = "timing-log")
        );
    }

    #[test]
    fn audio_counts_as_audible_only_above_about_minus_60_dbfs() {
        let quiet = audio_event("microphone", 1, 0, &[0.000_5; 160]);
        let heard = audio_event("microphone", 1, 0, &[0.0, -0.002, 0.0]);
        assert!(matches!(
            quiet,
            Event::AudioReceived {
                audible: false,
                duration_ms: 10,
                ..
            }
        ));
        assert!(matches!(heard, Event::AudioReceived { audible: true, .. }));
    }

    fn shown(session: u64, running: bool, cue: Option<&str>) -> Shown {
        Shown {
            session,
            running,
            cue: cue.map(str::to_owned),
        }
    }

    fn names(events: &[Event]) -> Vec<String> {
        events
            .iter()
            .map(|event| {
                let value = serde_json::to_value(event).unwrap();
                match (&value["event"], &value["state"], &value["cue"]) {
                    (Value::String(name), Value::String(state), _) => format!("{name}:{state}"),
                    (Value::String(name), _, Value::String(cue)) => format!("{name}:{cue}"),
                    (name, _, _) => name.to_string(),
                }
            })
            .collect()
    }

    #[test]
    fn published_snapshots_become_session_and_cue_events() {
        let steps = [
            (
                shown(0, false, None),
                shown(4, true, None),
                vec!["session:started"],
            ),
            (
                shown(4, true, None),
                shown(4, true, Some("a")),
                vec!["cue_published:a"],
            ),
            (shown(4, true, Some("a")), shown(4, true, Some("a")), vec![]),
            (
                shown(4, true, Some("a")),
                shown(4, true, Some("b")),
                vec!["cue_cleared:a", "cue_published:b"],
            ),
            (
                shown(4, true, Some("b")),
                shown(4, true, None),
                vec!["cue_cleared:b"],
            ),
            (
                shown(4, true, Some("c")),
                shown(4, false, None),
                vec!["session:ended", "cue_cleared:c"],
            ),
            (
                shown(4, true, Some("c")),
                shown(5, true, None),
                vec!["session:ended", "cue_cleared:c", "session:started"],
            ),
        ];
        for (before, after, expected) in steps {
            let events = shown_events(&before, &after, true, 9_000);
            assert_eq!(names(&events), expected, "{before:?} -> {after:?}");
        }
        let started = &shown_events(&shown(0, false, None), &shown(4, true, None), true, 0)[0];
        let value = serde_json::to_value(started).unwrap();
        assert_eq!(value["commit"], commit());
        assert!(value["features"].is_array());
    }

    fn segment(id: &str, at_ms: u64, text: &str) -> Segment {
        Segment {
            id: id.into(),
            at_ms,
            speaker: "Speaker 1".into(),
            text: text.into(),
        }
    }

    fn live_runtime() -> (Runtime, u64) {
        let mut runtime = Runtime {
            engine: Engine::live(),
            ..Runtime::default()
        };
        runtime.engine.start().unwrap();
        runtime.engine.advance(3_000);
        let session = runtime.engine.session();
        (runtime, session)
    }

    #[test]
    fn timed_ingest_behaves_like_the_engine_while_the_log_is_off() {
        // The test process never sets TALKQTE_TIMING_LOG.
        let (mut runtime, session) = live_runtime();
        runtime
            .ingest_timed(
                session,
                segment("l1", 1_000, "Someone should send the checklist."),
            )
            .unwrap();
        assert_eq!(runtime.engine.state.cue.as_ref().unwrap().source_id, "l1");
        assert!(runtime
            .ingest_timed(session, segment("l0", 500, "An earlier fictional line."))
            .is_err());
    }

    fn a_phrase_cue() -> Cue {
        let (mut runtime, session) = live_runtime();
        runtime
            .ingest_timed(
                session,
                segment("l2", 2_000, "Someone should send the checklist."),
            )
            .unwrap();
        runtime.engine.state.cue.clone().unwrap()
    }

    #[test]
    fn decisions_keep_the_question_only_for_a_phrase_cue_from_a_line() {
        let cue = a_phrase_cue();
        let value = serde_json::to_value(decision(3, &cue, 2_100)).unwrap();
        assert_eq!(value["source"], "line");
        assert_eq!(value["source_id"], "l2");
        assert_eq!(value["question"], cue.question.as_str());

        let mut note = cue.clone();
        note.kind = CONTEXT.into();
        note.question = "Fictional orchard budget note".into();
        note.source_id = "fictional-note-key".into();
        let mut still_open = cue.clone();
        still_open.kind = STILL_OPEN.into();
        still_open.question = "Not covered: fictional focus line".into();
        let mut focus = cue.clone();
        focus.about_focus = true;
        focus.question = "Who owns the fictional focus line?".into();
        for (cue, source) in [(note, "note"), (still_open, "focus"), (focus, "focus")] {
            let text = line(&decision(3, &cue, 2_100), 0, 0);
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["source"], source, "{text}");
            assert!(value.get("question").is_none(), "{text}");
            assert!(value.get("source_id").is_none(), "{text}");
            assert!(!text.contains("fictional"), "{text}");
        }
    }

    #[cfg(feature = "timing-log")]
    mod writing {
        use super::*;
        use std::sync::mpsc;

        fn scratch(name: &str) -> PathBuf {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "talkqte-timing-{}-{name}.jsonl",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            path
        }

        fn lines(path: &Path) -> Vec<Value> {
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        /// Collects each write call; fails the first `fail` of them.
        #[derive(Clone, Default)]
        struct Sink {
            writes: Arc<Mutex<Vec<Vec<u8>>>>,
            fail: Arc<AtomicU64>,
        }

        impl Write for Sink {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                if self.fail.load(Ordering::Acquire) > 0 {
                    self.fail.fetch_sub(1, Ordering::AcqRel);
                    return Err(io::Error::other("fictional full volume"));
                }
                self.writes.lock().unwrap().push(buf.to_vec());
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl Sink {
            /// The lines written, checking each was one write ending in a newline.
            fn lines(&self) -> Vec<Value> {
                self.writes
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|write| {
                        let text = std::str::from_utf8(write).unwrap();
                        assert_eq!(text.matches('\n').count(), 1, "{text:?}");
                        assert!(text.ends_with('\n'), "{text:?}");
                        serde_json::from_str(text).unwrap()
                    })
                    .collect()
            }
        }

        fn cleared(cue: &str) -> Event {
            Event::CueCleared {
                session: 7,
                cue: cue.into(),
                elapsed_ms: 0,
            }
        }

        fn timed(line: &Value) {
            assert!(
                line["wall_ms"].as_u64().unwrap() > 1_600_000_000_000,
                "{line}"
            );
            assert!(line["mono_ms"].is_u64(), "{line}");
        }

        #[test]
        fn the_log_is_written_only_to_an_absolute_path_outside_the_repository() {
            assert!(Log::open(Path::new("relative-timing.jsonl"), 4).is_err());
            assert!(Log::open(&checkout().join("timing.jsonl"), 4).is_err());
            assert!(Log::open(&checkout().join("docs/new/timing.jsonl"), 4).is_err());
            let climbing = std::env::temp_dir().join("..").join("timing.jsonl");
            assert!(Log::open(&climbing, 4).is_err());

            // A folder that does not exist is not created, and nothing is written.
            let mut missing = std::env::temp_dir();
            missing.push(format!("talkqte-no-such-folder-{}", std::process::id()));
            missing.push("timing.jsonl");
            let log = Log::open(&missing, 4).unwrap();
            log.record(&cleared("c1"));
            drop(log);
            assert!(!missing.parent().unwrap().exists(), "no folder is created");
        }

        #[test]
        fn each_event_is_one_json_line_with_wall_and_monotonic_times_in_order() {
            let path = scratch("order");
            let log = Log::open(&path, 16).unwrap();
            log.record(&audio_event("application", 7, 1_000, &[0.0; 16_000]));
            log.record(&Event::CuePublished {
                session: 7,
                cue: "c1".into(),
                elapsed_ms: 2_500,
            });
            drop(log); // Closes the queue and waits for the writer.
            let written = lines(&path);
            assert_eq!(written.len(), 2);
            assert_eq!(written[0]["event"], "audio_received");
            assert_eq!(written[0]["source"], "application");
            assert_eq!(written[0]["duration_ms"], 1_000);
            assert_eq!(written[0]["audible"], false);
            assert_eq!(written[1]["event"], "cue_published");
            assert_eq!(written[1]["cue"], "c1");
            written.iter().for_each(timed);
            assert!(written[0]["mono_ms"].as_u64() <= written[1]["mono_ms"].as_u64());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "readable by its owner only");
            }
            // Appending, not replacing: a second log adds to the file.
            let again = Log::open(&path, 4).unwrap();
            again.record(&cleared("c1"));
            drop(again);
            assert_eq!(lines(&path).len(), 3);
            let _ = std::fs::remove_file(&path);
        }

        #[cfg(unix)]
        #[test]
        fn a_link_or_a_pipe_is_never_opened() {
            let target = scratch("target");
            std::fs::write(&target, "").unwrap();
            let link = scratch("link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let log = Log::open(&link, 4).unwrap();
            log.record(&cleared("c1"));
            drop(log);
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "");
            let folder = std::env::temp_dir();
            assert!(
                open_file(&folder, checkout()).is_err(),
                "a folder is refused"
            );
            let _ = std::fs::remove_file(&link);
            let _ = std::fs::remove_file(&target);
        }

        #[test]
        fn lines_lost_to_a_full_queue_are_counted_and_reported_with_times() {
            let sink = Sink::default();
            let output = sink.clone();
            let (open, opened) = mpsc::channel::<()>();
            // The writer cannot take anything until the test lets it open.
            let log = Log::start(1, move || {
                opened.recv().ok();
                Ok(output)
            })
            .unwrap();
            log.record(&cleared("kept"));
            log.record(&cleared("lost-1"));
            log.record(&cleared("lost-2"));
            open.send(()).unwrap();
            drop(log);
            let written = sink.lines();
            assert_eq!(written.len(), 2, "{written:?}");
            assert_eq!(written[0]["event"], "dropped");
            assert_eq!(written[0]["count"], 2);
            assert_eq!(written[1]["cue"], "kept");
            written.iter().for_each(timed);
        }

        #[test]
        fn a_failed_write_is_counted_as_dropped() {
            let sink = Sink::default();
            sink.fail.store(1, Ordering::Release);
            let output = sink.clone();
            let log = Log::start(4, move || Ok(output)).unwrap();
            log.record(&cleared("failed"));
            log.record(&cleared("next"));
            drop(log);
            let written = sink.lines();
            assert_eq!(written.len(), 2, "{written:?}");
            assert_eq!(written[0]["event"], "dropped");
            assert_eq!(written[0]["count"], 1);
            assert_eq!(written[1]["cue"], "next");
        }

        #[test]
        fn a_line_that_raises_a_cue_records_the_decision_with_its_source_line() {
            let sink = Sink::default();
            let output = sink.clone();
            let log = Log::start(16, move || Ok(output)).unwrap();
            let (mut runtime, session) = live_runtime();
            for line in [
                segment("l1", 1_000, "The greenhouse keys are in the blue tin."),
                segment("l2", 2_000, "Someone should send the checklist."),
            ] {
                runtime.ingest_into(Some(&log), session, line).unwrap();
            }
            // A line the engine refuses is recorded as refused.
            let late = segment("l0", 500, "An earlier fictional line.");
            assert!(runtime.ingest_into(Some(&log), session, late).is_err());
            drop(log);
            let written = sink.lines();
            let events: Vec<_> = written
                .iter()
                .map(|line| {
                    format!(
                        "{}:{}:{}",
                        line["event"].as_str().unwrap(),
                        line["id"]
                            .as_str()
                            .or(line["source_id"].as_str())
                            .unwrap_or(""),
                        line["accepted"]
                    )
                })
                .collect();
            // The missing-owner rule fires on the second line, once.
            assert_eq!(
                events,
                [
                    "segment:l1:true",
                    "segment:l2:true",
                    "cue_decision:l2:null",
                    "segment:l0:false"
                ]
            );
            assert_eq!(written[2]["source"], "line");
            assert!(!written[2]["question"].as_str().unwrap().is_empty());
        }
    }
}
