//! "A call seems to be starting": a quiet offer to start a live session.
//!
//! Two signals, neither needing a permission: the default microphone is in
//! use by another process (Core Audio's "device is running somewhere"), and
//! which application is frontmost. When the microphone has been in use for a
//! moment, no TalkQTE session or microphone check runs, and the person has
//! turned the prompt on, the companion offers to start a session with the
//! microphone and, when the frontmost application is a known call app or a
//! browser, that application preselected. Nothing is captured, listed or sent
//! by the offer: it only opens the notebook's ordinary start. It never starts
//! a session by itself, and it shows once per spell of microphone use.
//!
//! Nothing is read while the prompt is off. What is read is whether the
//! microphone is in use and the frontmost application's name and bundle
//! identifier, never audio or window content, and it stays on this Mac.
//! The settings last for this launch only, as every TalkQTE setting does.

use serde::Serialize;
use std::time::{Duration, Instant};

/// How long the microphone must be in use before the offer, so a brief
/// dictation or a sound check does not raise it.
pub const SETTLE: Duration = Duration::from_secs(3);
/// The offer goes away by itself after this long.
pub const SHOWN_FOR: Duration = Duration::from_secs(45);
/// How often the macOS adapter reads the two signals while the prompt is on.
pub const POLL: Duration = Duration::from_secs(1);

/// The frontmost application, as macOS names it. Metadata only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frontmost {
    pub bundle_id: String,
    pub name: String,
}

/// What the signals were at one read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Signals {
    /// Another process has the default input device running.
    pub microphone_in_use: bool,
    pub frontmost: Option<Frontmost>,
}

/// How a frontmost application relates to a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A meeting application: its audio is the other side of the call.
    Meeting,
    /// A browser: it may hold a call (Google Meet, for example), but TalkQTE
    /// cannot tell a call from any other page without more permission, and
    /// capturing a browser's audio is unproven.
    Browser,
}

/// Bundle identifiers of applications offered as the call's other side.
const MEETING: &[&str] = &[
    "us.zoom.xos",
    "com.microsoft.teams2",
    "com.microsoft.teams",
    "com.apple.FaceTime",
    "com.cisco.webexmeetingsapp",
    "Cisco-Systems.Spark",
    "com.tinyspeck.slackmacgap",
];
const BROWSERS: &[&str] = &[
    "com.google.Chrome",
    "com.apple.Safari",
    "company.thebrowser.Browser",
    "org.mozilla.firefox",
    "com.microsoft.edgemac",
    "com.brave.Browser",
];

pub fn kind(bundle_id: &str) -> Option<Kind> {
    if MEETING.contains(&bundle_id) {
        Some(Kind::Meeting)
    } else if BROWSERS.contains(&bundle_id) {
        Some(Kind::Browser)
    } else {
        None
    }
}

/// The offer the companion shows. Metadata only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    /// The application to preselect beside the microphone, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    /// Identifies this offer, so a late answer to an earlier one is ignored.
    pub id: u64,
}

/// The person's choices. For this launch only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Off until the person turns it on.
    pub enabled: bool,
    /// Applications the person said not to ask about, by name.
    pub not_for: Vec<String>,
}

/// An answer from the companion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Answer {
    /// Open the notebook's start, with the offer's sources chosen.
    Start,
    /// Not now.
    Dismiss,
    /// Never offer for this offer's application.
    NotForThisApp,
    /// Turn the prompt off.
    DontAskAgain,
}

#[derive(Default)]
pub struct Watcher {
    settings: Settings,
    /// Bundle identifiers behind `settings.not_for`.
    not_for_ids: Vec<String>,
    /// When the current spell of microphone use began.
    in_use_since: Option<Instant>,
    /// This spell already had its offer, or TalkQTE itself was listening.
    spent: bool,
    prompt: Option<(Prompt, Instant, Option<String>)>,
    next_id: u64,
}

impl Watcher {
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Whether the adapter should read the signals at all.
    pub fn enabled(&self) -> bool {
        self.settings.enabled
    }

    /// Turn the prompt on or off. Off clears any offer and what was seen.
    pub fn set_enabled(&mut self, enabled: bool) -> bool {
        let changed = self.settings.enabled != enabled;
        self.settings.enabled = enabled;
        if !enabled {
            self.in_use_since = None;
            self.spent = false;
            return self.clear() || changed;
        }
        changed
    }

    /// Forget the applications the person said not to ask about.
    pub fn clear_not_for(&mut self) {
        self.settings.not_for.clear();
        self.not_for_ids.clear();
    }

    pub fn prompt(&self) -> Option<&Prompt> {
        self.prompt.as_ref().map(|(prompt, _, _)| prompt)
    }

    fn clear(&mut self) -> bool {
        self.prompt.take().is_some()
    }

    /// One read of the signals. `busy` is true while a TalkQTE live session
    /// starts or runs, or its microphone check is on: the microphone is then
    /// TalkQTE's own business, and that spell of use gets no offer. Returns
    /// whether the offer changed.
    pub fn observe(&mut self, signals: &Signals, busy: bool, now: Instant) -> bool {
        if !self.settings.enabled {
            return self.clear();
        }
        if busy {
            if self.in_use_since.is_some() || signals.microphone_in_use {
                self.spent = true;
            }
            return self.clear();
        }
        if !signals.microphone_in_use {
            self.in_use_since = None;
            self.spent = false;
            return self.clear();
        }
        let since = *self.in_use_since.get_or_insert(now);
        if let Some((_, shown, _)) = &self.prompt {
            if now.saturating_duration_since(*shown) >= SHOWN_FOR {
                return self.clear();
            }
            return false;
        }
        if self.spent || now.saturating_duration_since(since) < SETTLE {
            return false;
        }
        self.spent = true;
        let candidate = signals
            .frontmost
            .as_ref()
            .and_then(|app| kind(&app.bundle_id).map(|kind| (app, kind)));
        if let Some((app, _)) = candidate {
            if self.not_for_ids.contains(&app.bundle_id) {
                return false;
            }
        }
        self.next_id += 1;
        let prompt = Prompt {
            application: candidate.map(|(app, _)| app.name.clone()),
            kind: candidate.map(|(_, kind)| kind),
            id: self.next_id,
        };
        let bundle = candidate.map(|(app, _)| app.bundle_id.clone());
        self.prompt = Some((prompt, now, bundle));
        true
    }

    /// The person answered offer `id`. Returns the application to preselect
    /// when they chose to start, as `Some(application)`; a stale answer
    /// changes nothing.
    pub fn answer(&mut self, id: u64, answer: Answer) -> Option<Option<String>> {
        let (prompt, _, bundle) = self.prompt.take_if(|(prompt, _, _)| prompt.id == id)?;
        match answer {
            Answer::Start => return Some(prompt.application),
            Answer::Dismiss => {}
            Answer::NotForThisApp => {
                if let (Some(name), Some(bundle)) = (prompt.application, bundle) {
                    if !self.not_for_ids.contains(&bundle) {
                        self.not_for_ids.push(bundle);
                        self.settings.not_for.push(name);
                    }
                }
            }
            Answer::DontAskAgain => {
                self.set_enabled(false);
            }
        }
        None
    }
}

/// The two signals, read from macOS without any permission: the default
/// input device's "running somewhere" property and the frontmost
/// application. Neither opens the microphone or reads any content.
#[cfg(target_os = "macos")]
pub mod native {
    use super::{Frontmost, Signals};

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    const SYSTEM_OBJECT: u32 = 1;
    const fn code(text: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*text)
    }
    const GLOBAL: u32 = code(b"glob");
    const DEFAULT_INPUT: u32 = code(b"dIn ");
    const RUNNING_SOMEWHERE: u32 = code(b"gone");

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            data_size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }

    fn read_u32(object: u32, selector: u32) -> Option<u32> {
        let address = Address {
            selector,
            scope: GLOBAL,
            element: 0,
        };
        let mut value = 0_u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: a property read into a u32 of the size given; no capture.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut value as *mut u32).cast(),
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<u32>()).then_some(value)
    }

    /// Whether any process has the default input device running. TalkQTE's
    /// own microphone counts too; the watcher is told when that is so.
    pub fn microphone_in_use() -> bool {
        read_u32(SYSTEM_OBJECT, DEFAULT_INPUT)
            .filter(|device| *device != 0)
            .and_then(|device| read_u32(device, RUNNING_SOMEWHERE))
            .is_some_and(|running| running != 0)
    }

    pub fn frontmost() -> Option<Frontmost> {
        use objc2_app_kit::NSWorkspace;
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;
        let bundle_id = app.bundleIdentifier()?.to_string();
        let name = app.localizedName()?.to_string();
        Some(Frontmost { bundle_id, name })
    }

    pub fn read() -> Signals {
        Signals {
            microphone_in_use: microphone_in_use(),
            frontmost: frontmost(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zoom() -> Option<Frontmost> {
        Some(Frontmost {
            bundle_id: "us.zoom.xos".into(),
            name: "zoom.us".into(),
        })
    }

    fn on() -> Watcher {
        let mut watcher = Watcher::default();
        watcher.set_enabled(true);
        watcher
    }

    const IN_USE: fn(Option<Frontmost>) -> Signals = |frontmost| Signals {
        microphone_in_use: true,
        frontmost,
    };

    #[test]
    fn nothing_is_offered_while_the_prompt_is_off_which_it_is_by_default() {
        let mut watcher = Watcher::default();
        assert!(!watcher.enabled());
        let start = Instant::now();
        for second in 0..60 {
            watcher.observe(&IN_USE(zoom()), false, start + Duration::from_secs(second));
        }
        assert_eq!(watcher.prompt(), None);
    }

    #[test]
    fn a_call_app_using_the_microphone_for_a_moment_is_offered_once_then_goes_away() {
        let mut watcher = on();
        let start = Instant::now();
        assert!(!watcher.observe(&IN_USE(zoom()), false, start));
        // Not before it has settled.
        assert!(!watcher.observe(&IN_USE(zoom()), false, start + Duration::from_secs(2)));
        assert!(watcher.observe(&IN_USE(zoom()), false, start + SETTLE));
        let prompt = watcher.prompt().unwrap().clone();
        assert_eq!(prompt.application.as_deref(), Some("zoom.us"));
        assert_eq!(prompt.kind, Some(Kind::Meeting));
        // It goes away by itself and does not come back in the same call.
        assert!(watcher.observe(&IN_USE(zoom()), false, start + SETTLE + SHOWN_FOR));
        assert_eq!(watcher.prompt(), None);
        for second in 0..120 {
            watcher.observe(
                &IN_USE(zoom()),
                false,
                start + Duration::from_secs(100 + second),
            );
        }
        assert_eq!(watcher.prompt(), None);
        // A new spell of microphone use is a new call.
        let later = start + Duration::from_secs(300);
        watcher.observe(&Signals::default(), false, later);
        watcher.observe(&IN_USE(zoom()), false, later);
        assert!(watcher.observe(&IN_USE(zoom()), false, later + SETTLE));
        assert!(watcher.prompt().unwrap().id > prompt.id);
    }

    #[test]
    fn the_microphone_stopping_or_talkqte_listening_withdraws_the_offer() {
        let mut watcher = on();
        let start = Instant::now();
        watcher.observe(&IN_USE(zoom()), false, start);
        watcher.observe(&IN_USE(zoom()), false, start + SETTLE);
        assert!(watcher.prompt().is_some());
        assert!(watcher.observe(&Signals::default(), false, start + SETTLE * 2));
        assert_eq!(watcher.prompt(), None);
        // TalkQTE's own session uses the microphone: no offer then, nor for
        // the rest of that spell after the session ends.
        let next = start + Duration::from_secs(100);
        watcher.observe(&IN_USE(zoom()), true, next);
        watcher.observe(&IN_USE(zoom()), true, next + SETTLE);
        assert_eq!(watcher.prompt(), None);
        watcher.observe(&IN_USE(zoom()), false, next + SETTLE * 3);
        assert_eq!(watcher.prompt(), None);
    }

    #[test]
    fn an_unknown_app_gets_a_microphone_offer_and_a_browser_is_named_as_one() {
        let mut watcher = on();
        let start = Instant::now();
        let notes = Some(Frontmost {
            bundle_id: "com.example.fictional-notes".into(),
            name: "Fictional Notes".into(),
        });
        watcher.observe(&IN_USE(notes.clone()), false, start);
        watcher.observe(&IN_USE(notes), false, start + SETTLE);
        let prompt = watcher.prompt().unwrap();
        assert_eq!((prompt.application.as_deref(), prompt.kind), (None, None));

        let mut watcher = on();
        let chrome = Some(Frontmost {
            bundle_id: "com.google.Chrome".into(),
            name: "Google Chrome".into(),
        });
        watcher.observe(&IN_USE(chrome.clone()), false, start);
        watcher.observe(&IN_USE(chrome), false, start + SETTLE);
        assert_eq!(watcher.prompt().unwrap().kind, Some(Kind::Browser));
    }

    #[test]
    fn the_answers_start_dismiss_skip_an_app_or_turn_the_prompt_off() {
        let start = Instant::now();
        let offered = |watcher: &mut Watcher, at: Instant| {
            watcher.observe(&Signals::default(), false, at);
            watcher.observe(&IN_USE(zoom()), false, at);
            watcher.observe(&IN_USE(zoom()), false, at + SETTLE);
            watcher.prompt().map(|prompt| prompt.id)
        };
        let mut watcher = on();
        let id = offered(&mut watcher, start).unwrap();
        // A stale answer changes nothing.
        assert_eq!(watcher.answer(id + 1, Answer::Start), None);
        assert_eq!(
            watcher.answer(id, Answer::Start),
            Some(Some("zoom.us".to_string()))
        );
        assert_eq!(watcher.prompt(), None);

        let id = offered(&mut watcher, start + Duration::from_secs(60)).unwrap();
        assert_eq!(watcher.answer(id, Answer::Dismiss), None);
        assert!(offered(&mut watcher, start + Duration::from_secs(120)).is_some());

        let id = watcher.prompt().unwrap().id;
        watcher.answer(id, Answer::NotForThisApp);
        assert_eq!(watcher.settings().not_for, ["zoom.us"]);
        assert_eq!(
            offered(&mut watcher, start + Duration::from_secs(180)),
            None
        );
        watcher.clear_not_for();
        let id = offered(&mut watcher, start + Duration::from_secs(240)).unwrap();

        watcher.answer(id, Answer::DontAskAgain);
        assert!(!watcher.enabled());
        assert_eq!(
            offered(&mut watcher, start + Duration::from_secs(300)),
            None
        );
    }

    #[test]
    fn turning_it_off_withdraws_the_offer_at_once() {
        let mut watcher = on();
        let start = Instant::now();
        watcher.observe(&IN_USE(zoom()), false, start);
        watcher.observe(&IN_USE(zoom()), false, start + SETTLE);
        assert!(watcher.set_enabled(false));
        assert_eq!(watcher.prompt(), None);
    }
}
