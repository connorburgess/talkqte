//! Development-only timing log for lab runs with fictional audio.
//!
//! Off unless the build has the `timing-log` Cargo feature and the
//! `TALKQTE_TIMING_LOG` environment variable names an absolute file path.
//! Then one JSON object per line is appended to that file, and nothing is
//! sent anywhere. A default build cannot turn it on.
//!
//! Recording never runs in an audio callback. Events come from the
//! transcription runner, the application-source worker and the runtime, and
//! recording only formats a line and hands it to a writer thread without
//! waiting. A full queue drops the line and counts it; the writer reports the
//! count before its next line.

use crate::engine::{Cue, Engine, Segment, Status};
use crate::Runtime;
use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
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
    /// The engine first holds a cue, and the line it came from.
    CueDecision {
        session: u64,
        cue: String,
        kind: String,
        question: String,
        source_id: String,
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

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// An open log file and its writer thread.
pub struct Log {
    sender: Option<SyncSender<String>>,
    dropped: Arc<AtomicU64>,
    opened: Instant,
    writer: Option<JoinHandle<()>>,
}

impl Log {
    /// Append to `path`, which must be absolute. Its directory must exist:
    /// nothing else is created.
    pub fn open(path: &Path, capacity: usize) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("The timing log path must be absolute.".into());
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|_| "Could not open the timing log.".to_string())?;
        let (sender, receiver) = sync_channel::<String>(capacity.max(1));
        let dropped = Arc::new(AtomicU64::new(0));
        let lost = dropped.clone();
        let writer = std::thread::Builder::new()
            .name("talkqte-timing-log".into())
            .spawn(move || {
                for line in receiver {
                    let missed = lost.swap(0, Ordering::AcqRel);
                    if missed > 0 {
                        let _ = writeln!(file, "{{\"event\":\"dropped\",\"count\":{missed}}}");
                    }
                    let _ = writeln!(file, "{line}");
                    let _ = file.flush();
                }
            })
            .map_err(|_| "Could not start the timing log.".to_string())?;
        Ok(Self {
            sender: Some(sender),
            dropped,
            opened: Instant::now(),
            writer: Some(writer),
        })
    }

    /// Stamp and queue one event without waiting.
    pub fn record(&self, event: &Event) {
        let mono_ms = u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX);
        let line = line(event, wall_ms(), mono_ms);
        let sent = self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.try_send(line).is_ok());
        if !sent {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Drop for Log {
    fn drop(&mut self) {
        // Close the queue, then let the writer finish what it holds.
        self.sender.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

fn global() -> Option<&'static Log> {
    static LOG: OnceLock<Option<Log>> = OnceLock::new();
    LOG.get_or_init(|| {
        if !cfg!(feature = "timing-log") {
            return None;
        }
        let path = std::env::var_os(ENV)?;
        Log::open(Path::new(&path), QUEUE).ok()
    })
    .as_ref()
}

/// Whether events are being written. Always false in a default build.
pub fn enabled() -> bool {
    global().is_some()
}

pub fn record(event: Event) {
    if let Some(log) = global() {
        log.record(&event);
    }
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
    ]
    .into_iter()
    .filter_map(|(name, on)| on.then_some(name))
    .collect()
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
    if let Some(cue) = after.filter(|cue| Some(cue.id.as_str()) != before) {
        events.push(Event::CueDecision {
            session,
            cue: cue.id.clone(),
            kind: cue.kind.clone(),
            question: cue.question.clone(),
            source_id: cue.source_id.clone(),
            elapsed_ms,
        });
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
    if !enabled() {
        return;
    }
    static LAST: Mutex<Option<Shown>> = Mutex::new(None);
    let now = Shown::of(engine);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let before = last.clone().unwrap_or_default();
    for event in shown_events(&before, &now, engine.state.live, engine.state.elapsed_ms) {
        record(event);
    }
    *last = Some(now);
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
        if !enabled() {
            return self.engine.ingest(session, segment);
        }
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
            record(event);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn scratch(name: &str) -> std::path::PathBuf {
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

    #[test]
    fn a_default_build_never_turns_the_log_on() {
        if !cfg!(feature = "timing-log") {
            assert!(!enabled());
            // Nothing is formatted or queued either.
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
    fn the_log_is_written_only_to_an_absolute_path_in_an_existing_folder() {
        assert!(Log::open(Path::new("relative-timing.jsonl"), 4).is_err());
        let mut missing = std::env::temp_dir();
        missing.push(format!("talkqte-no-such-folder-{}", std::process::id()));
        missing.push("timing.jsonl");
        assert!(Log::open(&missing, 4).is_err());
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
        for line in &written {
            assert!(line["wall_ms"].as_u64().unwrap() > 1_600_000_000_000);
            assert!(line["mono_ms"].is_u64());
        }
        assert!(written[0]["mono_ms"].as_u64() <= written[1]["mono_ms"].as_u64());
        // Appending, not replacing: a second log adds to the file.
        let again = Log::open(&path, 4).unwrap();
        again.record(&Event::CueCleared {
            session: 7,
            cue: "c1".into(),
            elapsed_ms: 3_000,
        });
        drop(again);
        assert_eq!(lines(&path).len(), 3);
        let _ = std::fs::remove_file(&path);
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

    #[test]
    fn a_line_that_raises_a_cue_records_the_decision_with_its_source_line() {
        let mut engine = Engine::live();
        engine.start().unwrap();
        engine.advance(3_000);
        let session = engine.session();
        let mut decisions = Vec::new();
        for line in [
            segment("l1", 1_000, "The greenhouse keys are in the blue tin."),
            segment("l2", 2_000, "Someone should send the checklist."),
        ] {
            let before = engine.state.cue.as_ref().map(|cue| cue.id.clone());
            let accepted = engine.ingest(session, line.clone()).is_ok();
            let events = ingest_events(
                session,
                &line,
                accepted,
                before.as_deref(),
                engine.state.cue.as_ref(),
                engine.state.elapsed_ms,
            );
            assert!(matches!(&events[0], Event::Segment { accepted: true, .. }));
            decisions.extend(events.into_iter().skip(1));
        }
        // The missing-owner rule fires on the second line, once.
        assert_eq!(decisions.len(), 1);
        let Event::CueDecision {
            source_id,
            question,
            ..
        } = &decisions[0]
        else {
            panic!("not a decision: {decisions:?}");
        };
        assert_eq!(source_id, "l2");
        assert!(!question.is_empty());
        // A line the engine refuses is recorded as refused, with no decision.
        let late = segment("l0", 500, "An earlier fictional line.");
        let before = engine.state.cue.as_ref().map(|cue| cue.id.clone());
        let accepted = engine.ingest(session, late.clone()).is_ok();
        let events = ingest_events(
            session,
            &late,
            accepted,
            before.as_deref(),
            engine.state.cue.as_ref(),
            engine.state.elapsed_ms,
        );
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            Event::Segment {
                accepted: false,
                ..
            }
        ));
    }
}
