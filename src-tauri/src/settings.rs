//! The person's saved preferences: one small JSON file in the app's
//! Application Support directory, so the choices made in Settings are the same
//! at the next launch.
//!
//! It holds preferences only. Never a provider key (they stay in the
//! Keychain), and nothing from a meeting: no transcript, notes, cues, focus
//! lines, chosen sources or application names. The call-starting prompt's
//! "Not for <app>" answers are kept as bundle identifiers of the known
//! meeting applications and browsers, and nothing else.
//!
//! The file is read once at launch. Every field is checked on its own; one
//! that is missing, unknown or invalid takes its default, and the whole
//! result is built before any of it is applied, so a damaged file never stops
//! the app and is never half applied. Writes replace the file atomically
//! (a temporary file in the same directory, flushed, then renamed) and are
//! readable by the owner only.
//!
//! A lab run neither reads nor writes it: its launch settings describe the
//! whole run, and the person's own choices must not leak into its evidence.
//! Other development launch settings (a name, a transcription language)
//! apply over the file for that launch and are never written to it.

use crate::{
    call_prompt,
    engine::{CompanionPosition, QuestionSize, Sensitivity},
    llm_provider::{self, CueProvider},
    transcription::cloud::Language,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const FILE_NAME: &str = "settings.json";
/// The file's format. A file without this version is not read: its fields
/// may mean something else, so every setting takes its default. A file from
/// a newer version is also left untouched (see `Saving::Newer`).
pub const VERSION: u64 = 1;
/// A settings file is a few hundred bytes; anything far larger is not one.
const MAX_BYTES: u64 = 64 * 1024;

pub const SIDEBAR_WIDTH: (f64, f64) = (200.0, 400.0);
pub const NOTES_RATIO: (f64, f64) = (0.15, 0.85);

/// Everything the file can hold, already validated.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub transcription_language: Language,
    pub cue_provider: CueProvider,
    pub cue_model_override: Option<String>,
    /// One of `anthropic_api::MODELS`.
    pub notes_model: &'static str,
    pub notes_model_override: Option<String>,
    pub question_size: QuestionSize,
    pub companion_position: CompanionPosition,
    pub sensitivity: Sensitivity,
    /// The floating question window (the companion).
    pub overlay_enabled: bool,
    pub panels: Panels,
    pub user_name: Option<String>,
    pub call_prompt_enabled: bool,
    /// Bundle identifiers the call-starting prompt skips; each one is a
    /// known meeting application or browser.
    pub call_prompt_not_for: Vec<String>,
    /// Closing the notebook leaves TalkQTE in the menu bar instead of
    /// quitting. Off until the person turns it on.
    pub keep_running_in_menu_bar: bool,
}

/// Notebook panel sizes. `None` follows the window's width.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Panels {
    pub sidebar_width: Option<f64>,
    pub notes_ratio: Option<f64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            transcription_language: Language::English,
            cue_provider: CueProvider::Anthropic,
            cue_model_override: None,
            notes_model: crate::meeting_notes::DEFAULT_MODEL,
            notes_model_override: None,
            question_size: QuestionSize::Standard,
            companion_position: CompanionPosition::BottomRight,
            sensitivity: Sensitivity::Balanced,
            overlay_enabled: true,
            panels: Panels::default(),
            user_name: None,
            call_prompt_enabled: false,
            call_prompt_not_for: Vec::new(),
            keep_running_in_menu_bar: false,
        }
    }
}

fn within(value: Option<f64>, (low, high): (f64, f64)) -> Option<f64> {
    value.filter(|value| value.is_finite() && (low..=high).contains(value))
}

impl Panels {
    /// Sizes outside the notebook's limits are dropped, not clamped: the
    /// notebook then uses its own default for that panel.
    pub fn validated(self) -> Self {
        Self {
            sidebar_width: within(self.sidebar_width, SIDEBAR_WIDTH),
            notes_ratio: within(self.notes_ratio, NOTES_RATIO),
        }
    }
}

fn valid_name(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty() && crate::engine::valid_user_name(name)).then(|| name.to_string())
}

fn known_skip(bundle_id: &str) -> bool {
    call_prompt::kind(bundle_id).is_some()
}

/// One field: its value if valid, otherwise the default.
fn field<T: serde::de::DeserializeOwned>(object: &Map<String, Value>, key: &str, default: T) -> T {
    object
        .get(key)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or(default)
}

/// Reads settings from the file's bytes. Never fails: anything unreadable
/// gives the defaults, field by field.
pub fn parse(bytes: &[u8]) -> Settings {
    let defaults = Settings::default();
    let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(bytes) else {
        return defaults;
    };
    if object.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return defaults;
    }
    let cue_model_override = object
        .get("cueModelOverride")
        .and_then(Value::as_str)
        .and_then(|value| llm_provider::validate_model_id(value).ok().flatten());
    let notes_model = object
        .get("notesModel")
        .and_then(Value::as_str)
        .and_then(crate::anthropic_api::model)
        .map_or(defaults.notes_model, |model| model.id);
    let notes_model_override = object
        .get("notesModelOverride")
        .and_then(Value::as_str)
        .and_then(|value| llm_provider::validate_model_id(value).ok().flatten());
    let panels = object
        .get("panels")
        .and_then(Value::as_object)
        .map(|panels| {
            Panels {
                sidebar_width: panels.get("sidebarWidth").and_then(Value::as_f64),
                notes_ratio: panels.get("notesRatio").and_then(Value::as_f64),
            }
            .validated()
        })
        .unwrap_or_default();
    let user_name = object
        .get("userName")
        .and_then(Value::as_str)
        .and_then(valid_name);
    let call_prompt = object.get("callPrompt").and_then(Value::as_object);
    let call_prompt_enabled = call_prompt
        .and_then(|prompt| prompt.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(defaults.call_prompt_enabled);
    let mut call_prompt_not_for: Vec<String> = Vec::new();
    for bundle in call_prompt
        .and_then(|prompt| prompt.get("notFor"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|bundle| known_skip(bundle))
    {
        if !call_prompt_not_for.iter().any(|kept| kept == bundle) {
            call_prompt_not_for.push(bundle.to_string());
        }
    }
    Settings {
        transcription_language: field(
            &object,
            "transcriptionLanguage",
            defaults.transcription_language,
        ),
        cue_provider: field(&object, "cueProvider", defaults.cue_provider),
        cue_model_override,
        notes_model,
        notes_model_override,
        question_size: field(&object, "questionSize", defaults.question_size),
        companion_position: field(&object, "companionPosition", defaults.companion_position),
        sensitivity: field(&object, "sensitivity", defaults.sensitivity),
        overlay_enabled: field(&object, "floatingWindow", defaults.overlay_enabled),
        panels,
        user_name,
        call_prompt_enabled,
        call_prompt_not_for,
        keep_running_in_menu_bar: field(
            &object,
            "keepRunningInMenuBar",
            defaults.keep_running_in_menu_bar,
        ),
    }
}

/// The file's bytes for `settings`.
pub fn render(settings: &Settings) -> Vec<u8> {
    let value = json!({
        "version": VERSION,
        "transcriptionLanguage": settings.transcription_language,
        "cueProvider": settings.cue_provider,
        "cueModelOverride": settings.cue_model_override,
        "notesModel": settings.notes_model,
        "notesModelOverride": settings.notes_model_override,
        "questionSize": settings.question_size,
        "companionPosition": settings.companion_position,
        "sensitivity": settings.sensitivity,
        "floatingWindow": settings.overlay_enabled,
        "panels": settings.panels,
        "userName": settings.user_name,
        "callPrompt": {
            "enabled": settings.call_prompt_enabled,
            "notFor": settings.call_prompt_not_for,
        },
        "keepRunningInMenuBar": settings.keep_running_in_menu_bar,
    });
    let mut bytes = serde_json::to_vec_pretty(&value).expect("settings serialize");
    bytes.push(b'\n');
    bytes
}

/// Whether `bytes` were written by a newer TalkQTE, whose format this one
/// does not know.
pub fn newer(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("version").and_then(Value::as_u64))
        .is_some_and(|version| version > VERSION)
}

/// What the file at `path` gave.
#[derive(Debug, PartialEq)]
pub enum Contents {
    Settings(Settings),
    /// Written by a newer version: not applied, and not to be overwritten.
    Newer,
}

/// Reads the file at `path`. A missing, oversized, unreadable or damaged
/// file gives the defaults.
pub fn read(path: &Path) -> Contents {
    let defaults = Contents::Settings(Settings::default());
    let Ok(file) = fs::File::open(path) else {
        return defaults;
    };
    if file
        .metadata()
        .map_or(true, |meta| !meta.is_file() || meta.len() > MAX_BYTES)
    {
        return defaults;
    }
    let mut bytes = Vec::new();
    use std::io::Read;
    if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err() {
        return defaults;
    }
    if newer(&bytes) {
        return Contents::Newer;
    }
    Contents::Settings(parse(&bytes))
}

/// Replaces the file at `path` with `settings`, atomically, owner-only.
pub fn write(path: &Path, settings: &Settings) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("The settings file has no folder."))?;
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        // A leftover temporary file from an earlier failed write keeps its
        // own mode; set it again.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&render(settings))?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Whether this launch is a lab run: the lab launcher always gives these,
/// and nothing else does. Development launches only; a release build has no
/// lab runs and always uses the file.
pub(crate) fn lab_run() -> bool {
    #[cfg(debug_assertions)]
    {
        lab_run_in(|name| std::env::var_os(name).is_some())
    }
    #[cfg(not(debug_assertions))]
    false
}

/// The lab launcher (`scripts/cue-lab-launcher.mjs`) always sets the run
/// identifier and the timing log; the others mark a lab launch made by hand.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub(crate) const LAB_SETTINGS: &[&str] = &[
    "TALKQTE_DEV_LAB_RUN_ID",
    "TALKQTE_TIMING_LOG",
    "TALKQTE_DEV_CUE_BACKEND",
    "TALKQTE_DEV_LAB_DESCRIPTOR",
    "TALKQTE_DEV_LAB_CONTEXT",
    "TALKQTE_DEV_APPLICATION_SOURCE",
    "TALKQTE_DEV_PLAYER_PID",
];

#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub(crate) fn lab_run_in(present: impl Fn(&str) -> bool) -> bool {
    LAB_SETTINGS.iter().any(|name| present(name))
}

/// Whether choices are being saved, for Settings to say.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Saving {
    /// Saved to the settings file.
    On,
    /// A lab run: the file is not read or written.
    LabRun,
    /// The app has no Application Support directory to use.
    Unavailable,
    /// The file was written by a newer TalkQTE. This one uses its defaults
    /// and leaves the file as it is, so going back a version loses nothing;
    /// Reset settings deletes it.
    Newer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub saving: Saving,
    /// The last write's failure, if it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Inner {
    path: Option<PathBuf>,
    saving: Saving,
    saved: Settings,
    error: Option<String>,
}

/// The settings file for this launch: what it holds and where it is.
pub struct Store(Mutex<Inner>);

impl Store {
    /// Opens the settings at `path` (`None` when there is nowhere to keep
    /// them) and returns what to apply. In a lab run nothing is read.
    pub fn open(path: Option<PathBuf>, lab_run: bool) -> (Self, Settings) {
        let (path, saving) = match (lab_run, path) {
            (true, _) => (None, Saving::LabRun),
            (false, None) => (None, Saving::Unavailable),
            (false, Some(path)) => (Some(path), Saving::On),
        };
        let (saving, saved) = match path.as_deref().map(read) {
            Some(Contents::Newer) => (Saving::Newer, Settings::default()),
            Some(Contents::Settings(saved)) => (saving, saved),
            None => (saving, Settings::default()),
        };
        let store = Self(Mutex::new(Inner {
            path,
            saving,
            saved: saved.clone(),
            error: None,
        }));
        (store, saved)
    }

    /// The store for the running app, in its Application Support directory.
    pub fn for_app(app: &tauri::AppHandle) -> (Self, Settings) {
        use tauri::Manager;
        let path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(FILE_NAME));
        Self::open(path, lab_run())
    }

    pub fn saved(&self) -> Settings {
        self.0
            .lock()
            .map(|inner| inner.saved.clone())
            .unwrap_or_default()
    }

    pub fn status(&self) -> Status {
        self.0
            .lock()
            .map(|inner| Status {
                saving: inner.saving,
                error: inner.error.clone(),
            })
            .unwrap_or(Status {
                saving: Saving::Unavailable,
                error: None,
            })
    }

    /// Records a change the person made and writes the file when it changed
    /// anything. A failed write leaves the choice in effect for this launch
    /// and is reported in Settings.
    pub fn record(&self, change: impl FnOnce(&mut Settings)) {
        let Ok(mut inner) = self.0.lock() else {
            return;
        };
        let mut next = inner.saved.clone();
        change(&mut next);
        if next == inner.saved {
            return;
        }
        inner.saved = next;
        let Some(path) = inner.path.clone().filter(|_| inner.saving == Saving::On) else {
            return;
        };
        inner.error = write(&path, &inner.saved)
            .err()
            .map(|_| "Your settings could not be saved, so they last until you quit.".into());
    }

    /// Deletes the file; every setting is back to its default.
    pub fn reset(&self) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|_| "Settings are unavailable.")?;
        if let Some(path) = &inner.path {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("The settings file could not be removed.".into()),
            }
        }
        inner.saved = Settings::default();
        inner.error = None;
        if inner.saving == Saving::Newer {
            inner.saving = Saving::On;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> tempdir::Folder {
        tempdir::Folder::new()
    }

    /// A temporary folder for one test, removed afterwards. Never the real
    /// Application Support directory.
    mod tempdir {
        pub struct Folder(pub std::path::PathBuf);
        impl Folder {
            pub fn new() -> Self {
                use std::sync::atomic::{AtomicU64, Ordering};
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let path = std::env::temp_dir().join(format!(
                    "talkqte-settings-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                let _ = std::fs::remove_dir_all(&path);
                Self(path)
            }
            pub fn file(&self) -> std::path::PathBuf {
                self.0.join("com.talkqte.desktop").join(super::FILE_NAME)
            }
        }
        impl Drop for Folder {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn chosen() -> Settings {
        Settings {
            transcription_language: Language::Multilingual,
            cue_provider: CueProvider::OpenAi,
            cue_model_override: Some("gpt-5.4-codex".into()),
            notes_model: "claude-haiku-5-5",
            notes_model_override: Some("gpt-4.1".into()),
            question_size: QuestionSize::Large,
            companion_position: CompanionPosition::TopLeft,
            sensitivity: Sensitivity::Focused,
            overlay_enabled: false,
            panels: Panels {
                sidebar_width: Some(312.0),
                notes_ratio: Some(0.6),
            },
            user_name: Some("Zoë O’Neil-Ray".into()),
            call_prompt_enabled: true,
            call_prompt_not_for: vec!["us.zoom.xos".into(), "com.apple.Safari".into()],
            keep_running_in_menu_bar: true,
        }
    }

    #[test]
    fn every_choice_survives_a_write_and_a_read() {
        let folder = folder();
        let (store, first) = Store::open(Some(folder.file()), false);
        assert_eq!(first, Settings::default());
        store.record(|settings| *settings = chosen());
        assert_eq!(store.status().error, None);
        let (_, next_launch) = Store::open(Some(folder.file()), false);
        assert_eq!(next_launch, chosen());
    }

    #[test]
    fn the_file_is_the_owners_alone_and_leaves_no_temporary_file() {
        let folder = folder();
        let (store, _) = Store::open(Some(folder.file()), false);
        store.record(|settings| settings.call_prompt_enabled = true);
        store.record(|settings| settings.sensitivity = Sensitivity::Quiet);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(folder.file()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let names: Vec<_> = fs::read_dir(folder.file().parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, [FILE_NAME]);
    }

    #[test]
    fn it_holds_preferences_and_nothing_else() {
        let text = String::from_utf8(render(&chosen())).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "callPrompt",
                "companionPosition",
                "cueModelOverride",
                "cueProvider",
                "floatingWindow",
                "keepRunningInMenuBar",
                "notesModel",
                "notesModelOverride",
                "panels",
                "questionSize",
                "sensitivity",
                "transcriptionLanguage",
                "userName",
                "version"
            ]
        );
        // The skipped applications are bundle identifiers, not names.
        assert_eq!(
            value["callPrompt"]["notFor"],
            json!(["us.zoom.xos", "com.apple.Safari"])
        );
        assert!(!text.contains("Zoom\""));
    }

    #[test]
    fn a_missing_damaged_or_foreign_file_gives_the_defaults() {
        let folder = folder();
        assert_eq!(
            read(&folder.file()),
            Contents::Settings(Settings::default())
        );
        for bytes in [
            &b""[..],
            b"not json",
            b"[1, 2]",
            b"{\"sensitivity\": \"quiet\"}",
            b"{\"version\": \"1\", \"sensitivity\": \"quiet\"}",
        ] {
            assert_eq!(parse(bytes), Settings::default(), "{:?}", bytes);
        }
        fs::create_dir_all(folder.file().parent().unwrap()).unwrap();
        fs::write(folder.file(), vec![b' '; (MAX_BYTES + 1) as usize]).unwrap();
        assert_eq!(
            read(&folder.file()),
            Contents::Settings(Settings::default())
        );
    }

    #[test]
    fn a_file_from_a_newer_version_is_not_applied_or_overwritten_until_reset() {
        let folder = folder();
        fs::create_dir_all(folder.file().parent().unwrap()).unwrap();
        let newer = br#"{"version": 2, "sensitivity": "quiet", "new": true}"#;
        fs::write(folder.file(), newer).unwrap();
        let (store, applied) = Store::open(Some(folder.file()), false);
        assert_eq!(applied, Settings::default());
        assert_eq!(store.status().saving, Saving::Newer);
        store.record(|settings| settings.sensitivity = Sensitivity::Focused);
        assert_eq!(fs::read(folder.file()).unwrap(), newer);
        // The person can choose to start over; then choices are saved.
        store.reset().unwrap();
        assert!(!folder.file().exists());
        store.record(|settings| settings.sensitivity = Sensitivity::Focused);
        assert_eq!(read(&folder.file()), Contents::Settings(store.saved()));
    }

    /// Version 1 as this release writes it. A later format must still read
    /// this file (or migrate it); change the test only with a migration.
    #[test]
    fn a_version_1_file_reads_as_written() {
        let file = br#"{
  "callPrompt": { "enabled": true, "notFor": ["com.microsoft.teams2"] },
  "companionPosition": "topCenter",
  "floatingWindow": true,
  "notesModel": "claude-sonnet-5-5",
  "panels": { "notesRatio": null, "sidebarWidth": 240.0 },
  "questionSize": "standard",
  "sensitivity": "quiet",
  "transcriptionLanguage": "en",
  "userName": "Sam",
  "version": 1
}"#;
        let settings = parse(file);
        assert_eq!(
            settings,
            Settings {
                notes_model: "claude-sonnet-5-5",
                companion_position: CompanionPosition::TopCenter,
                sensitivity: Sensitivity::Quiet,
                panels: Panels {
                    sidebar_width: Some(240.0),
                    notes_ratio: None,
                },
                user_name: Some("Sam".into()),
                call_prompt_enabled: true,
                call_prompt_not_for: vec!["com.microsoft.teams2".into()],
                ..Settings::default()
            }
        );
        assert_eq!(parse(&render(&settings)), settings);
    }

    #[test]
    fn each_invalid_field_takes_its_default_and_the_rest_are_kept() {
        let parsed = parse(
            br#"{
                "version": 1,
                "transcriptionLanguage": "fr",
                "cueProvider": "other-provider",
                "cueModelOverride": "bad model with spaces",
                "notesModel": "some-other-model",
                "notesModelOverride": "../traversal",
                "questionSize": "large",
                "companionPosition": "middle",
                "sensitivity": 3,
                "floatingWindow": "no",
                "panels": { "sidebarWidth": 9000, "notesRatio": 0.4 },
                "userName": "Robert'); DROP",
                "callPrompt": {
                    "enabled": true,
                    "notFor": ["us.zoom.xos", "com.example.unknown", 4, "us.zoom.xos"]
                },
                "transcript": "an unknown field is ignored",
                "keys": { "anthropic": "never read" }
            }"#,
        );
        assert_eq!(
            parsed,
            Settings {
                question_size: QuestionSize::Large,
                panels: Panels {
                    sidebar_width: None,
                    notes_ratio: Some(0.4),
                },
                call_prompt_enabled: true,
                call_prompt_not_for: vec!["us.zoom.xos".into()],
                ..Settings::default()
            }
        );
    }

    #[test]
    fn a_lab_run_neither_reads_nor_writes_the_file() {
        let folder = folder();
        let (store, _) = Store::open(Some(folder.file()), false);
        store.record(|settings| *settings = chosen());
        let before = fs::read(folder.file()).unwrap();

        let (lab, applied) = Store::open(Some(folder.file()), true);
        assert_eq!(applied, Settings::default());
        assert_eq!(lab.status().saving, Saving::LabRun);
        lab.record(|settings| settings.sensitivity = Sensitivity::Balanced);
        lab.reset().unwrap();
        assert_eq!(fs::read(folder.file()).unwrap(), before);
    }

    #[test]
    fn a_lab_launch_is_recognised_and_other_development_settings_are_not() {
        assert!(!lab_run_in(|_| false));
        for name in ["TALKQTE_DEV_LAB_RUN_ID", "TALKQTE_TIMING_LOG"] {
            assert!(lab_run_in(|present| present == name), "{name}");
        }
        // A development name or language applies over the file instead.
        for name in ["TALKQTE_DEV_USER_NAME", "TALKQTE_DEV_STT_LANGUAGE"] {
            assert!(!lab_run_in(|present| present == name), "{name}");
        }
    }

    #[test]
    fn reset_deletes_the_file_and_an_unchanged_choice_writes_nothing() {
        let folder = folder();
        let (store, _) = Store::open(Some(folder.file()), false);
        store.record(|_| {});
        assert!(!folder.file().exists());
        store.record(|settings| settings.overlay_enabled = false);
        assert!(folder.file().exists());
        store.reset().unwrap();
        assert!(!folder.file().exists());
        assert_eq!(store.saved(), Settings::default());
        // Resetting with no file is fine too.
        store.reset().unwrap();
    }

    #[test]
    fn a_failed_write_is_reported_and_the_choice_still_holds() {
        let folder = folder();
        // A file where the folder should be: the write cannot happen.
        fs::create_dir_all(&folder.0).unwrap();
        let blocked = folder.0.join("blocked");
        fs::write(&blocked, b"").unwrap();
        let (store, _) = Store::open(Some(blocked.join(FILE_NAME)), false);
        store.record(|settings| settings.sensitivity = Sensitivity::Quiet);
        assert!(store.status().error.is_some());
        assert_eq!(store.saved().sensitivity, Sensitivity::Quiet);
    }
}
