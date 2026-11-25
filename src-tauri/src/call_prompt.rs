//! "A call seems to be starting": a quiet offer to start a live session, or
//! opt-in automatic start when a known call application or browser uses the
//! microphone.
//!
//! Two signals, neither needing a permission: the default microphone is in
//! use by another process (Core Audio's "device is running somewhere"), and
//! which application is frontmost. When the microphone has been in use for a
//! moment, no TalkQTE session or microphone check runs, and the person has
//! turned the prompt or auto-start on, TalkQTE either offers in the companion
//! to start a session (1-click Start) or, if auto-start is opted in and a
//! known meeting app or browser is active with keys configured, starts a live
//! session immediately and shows Listening · Stop in the companion.
//!
//! Nothing is read while both prompt and auto-start are off. What is read is
//! whether the microphone is in use and the frontmost application's name and
//! bundle identifier, never audio or window content, and it stays on this Mac.
//! The settings and the applications not to ask about are kept in the
//! settings file (`settings.rs`), the latter as bundle identifiers only.

use serde::Serialize;
use std::time::{Duration, Instant};

/// How long the microphone must be in use before the offer, so a brief
/// dictation or a sound check does not raise it.
pub const SETTLE: Duration = Duration::from_secs(3);
/// The offer goes away by itself after this long.
pub const SHOWN_FOR: Duration = Duration::from_secs(45);
/// How often the macOS adapter reads the two signals while the prompt is on.
pub const POLL: Duration = Duration::from_secs(1);
/// After Not now, or an offer left to go away by itself, the same
/// application is not offered again for this long, so one call that briefly
/// releases the microphone (muting, a device change) is asked about once.
pub const QUIET_FOR: Duration = Duration::from_secs(20 * 60);

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

/// How Settings names a known application after a restart, when only its
/// bundle identifier was kept.
pub fn known_name(bundle_id: &str) -> Option<&'static str> {
    Some(match bundle_id {
        "us.zoom.xos" => "Zoom",
        "com.microsoft.teams2" | "com.microsoft.teams" => "Microsoft Teams",
        "com.apple.FaceTime" => "FaceTime",
        "com.cisco.webexmeetingsapp" | "Cisco-Systems.Spark" => "Webex",
        "com.tinyspeck.slackmacgap" => "Slack",
        "com.google.Chrome" => "Google Chrome",
        "com.apple.Safari" => "Safari",
        "company.thebrowser.Browser" => "Arc",
        "org.mozilla.firefox" => "Firefox",
        "com.microsoft.edgemac" => "Microsoft Edge",
        "com.brave.Browser" => "Brave",
        _ => return None,
    })
}

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

/// The application the notebook chooses once it is listed, matched by
/// bundle identifier. Sent to the notebook only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preselect {
    pub name: String,
    pub bundle_id: String,
}

/// The person's choices, as Settings shows them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Offer in the dock when a call seems to start. Off until the person
    /// turns it on.
    pub enabled: bool,
    /// Start a live session automatically when a known meeting app or browser
    /// uses the microphone for `SETTLE`. Off by default.
    pub auto_start: bool,
    /// Applications the person said not to ask about, by name.
    pub not_for: Vec<String>,
}

/// An automatic session start triggered for a known meeting app or browser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoStart {
    pub bundle_id: String,
    pub application: String,
    pub kind: Kind,
}

/// Result of one observation of the signals.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Observation {
    pub prompt_changed: bool,
    pub auto_start: Option<AutoStart>,
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
    /// Until when each application (by bundle identifier; `None` for an
    /// unknown one) is not offered again.
    quiet: Vec<(Option<String>, Instant)>,
}

impl Watcher {
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Whether the adapter should read the signals at all.
    pub fn enabled(&self) -> bool {
        self.settings.enabled
    }

    /// Whether auto-start when a call begins is enabled.
    pub fn auto_start(&self) -> bool {
        self.settings.auto_start
    }

    /// Whether either the dock offer or auto-start needs signal polling.
    pub fn watching(&self) -> bool {
        self.settings.enabled || self.settings.auto_start
    }

    /// Turn the prompt on or off. Off clears any offer and what was seen
    /// when auto-start is also off.
    pub fn set_enabled(&mut self, enabled: bool) -> bool {
        let changed = self.settings.enabled != enabled;
        self.settings.enabled = enabled;
        if !enabled {
            if !self.settings.auto_start {
                self.in_use_since = None;
                self.spent = false;
            }
            return self.clear() || changed;
        }
        changed
    }

    /// Turn automatic start on or off.
    pub fn set_auto_start(&mut self, auto_start: bool) -> bool {
        let changed = self.settings.auto_start != auto_start;
        self.settings.auto_start = auto_start;
        if !self.watching() {
            self.in_use_since = None;
            self.spent = false;
            return self.clear() || changed;
        }
        changed
    }

    /// Bundle identifiers of the applications not to ask about, as saved.
    pub fn not_for_ids(&self) -> &[String] {
        &self.not_for_ids
    }

    /// Restores saved choices at launch, or the defaults on a reset. Only
    /// known applications are kept, named as Settings names them.
    pub fn restore(&mut self, enabled: bool, auto_start: bool, not_for_ids: &[String]) {
        self.set_enabled(enabled);
        self.set_auto_start(auto_start);
        self.clear_not_for();
        for bundle in not_for_ids {
            if let Some(name) = known_name(bundle) {
                if !self.not_for_ids.contains(bundle) {
                    self.not_for_ids.push(bundle.clone());
                    self.settings.not_for.push(name.to_string());
                }
            }
        }
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
    /// TalkQTE's own business, and that spell of use gets no offer or
    /// auto-start. Returns whether the offer changed.
    pub fn observe(&mut self, signals: &Signals, busy: bool, now: Instant) -> bool {
        self.observe_with(signals, busy, false, now).prompt_changed
    }

    /// One read of the signals, also returning an automatic start when
    /// `auto_start` is enabled, `can_auto_start` is true (keys are configured
    /// and not a lab run), and a known meeting app or browser has used the
    /// microphone for `SETTLE`.
    pub fn observe_with(
        &mut self,
        signals: &Signals,
        busy: bool,
        can_auto_start: bool,
        now: Instant,
    ) -> Observation {
        if !self.watching() {
            return Observation {
                prompt_changed: self.clear(),
                auto_start: None,
            };
        }
        if busy {
            if self.in_use_since.is_some() || signals.microphone_in_use {
                self.spent = true;
            }
            return Observation {
                prompt_changed: self.clear(),
                auto_start: None,
            };
        }
        if !signals.microphone_in_use {
            self.in_use_since = None;
            self.spent = false;
            return Observation {
                prompt_changed: self.clear(),
                auto_start: None,
            };
        }
        let since = *self.in_use_since.get_or_insert(now);
        if let Some((_, shown, bundle)) = &self.prompt {
            if now.saturating_duration_since(*shown) >= SHOWN_FOR {
                // Left to go away: as Not now, for the rest of this call.
                let bundle = bundle.clone();
                self.quiet_for(bundle, now);
                return Observation {
                    prompt_changed: self.clear(),
                    auto_start: None,
                };
            }
            return Observation::default();
        }
        self.quiet.retain(|(_, until)| *until > now);
        if self.spent || now.saturating_duration_since(since) < SETTLE {
            return Observation::default();
        }
        self.spent = true;
        let candidate = signals
            .frontmost
            .as_ref()
            .and_then(|app| kind(&app.bundle_id).map(|kind| (app, kind)));
        let bundle = candidate.map(|(app, _)| app.bundle_id.clone());
        if bundle
            .as_ref()
            .is_some_and(|bundle| self.not_for_ids.contains(bundle))
            || self.quiet.iter().any(|(quiet, _)| *quiet == bundle)
        {
            return Observation::default();
        }
        if self.settings.auto_start && can_auto_start {
            if let Some((app, app_kind)) = candidate {
                return Observation {
                    prompt_changed: self.clear(),
                    auto_start: Some(AutoStart {
                        bundle_id: app.bundle_id.clone(),
                        application: app.name.clone(),
                        kind: app_kind,
                    }),
                };
            }
        }
        if !self.settings.enabled {
            return Observation::default();
        }
        self.next_id += 1;
        let prompt = Prompt {
            application: candidate.map(|(app, _)| app.name.clone()),
            kind: candidate.map(|(_, kind)| kind),
            id: self.next_id,
        };
        self.prompt = Some((prompt, now, bundle));
        Observation {
            prompt_changed: true,
            auto_start: None,
        }
    }

    fn quiet_for(&mut self, bundle: Option<String>, now: Instant) {
        self.quiet.retain(|(quiet, _)| *quiet != bundle);
        self.quiet.push((bundle, now + QUIET_FOR));
    }

    /// The person answered offer `id`. Returns what to preselect beside the
    /// microphone when they chose to start: a meeting application's name and
    /// bundle identifier, or nothing for a browser (whose audio would include
    /// every tab; the person can add it) or an unknown application. A stale
    /// answer changes nothing.
    pub fn answer(&mut self, id: u64, answer: Answer, now: Instant) -> Option<Option<Preselect>> {
        let (prompt, _, bundle) = self.prompt.take_if(|(prompt, _, _)| prompt.id == id)?;
        match answer {
            Answer::Start => {
                return Some(match (prompt.kind, prompt.application, bundle) {
                    (Some(Kind::Meeting), Some(name), Some(bundle_id)) => {
                        Some(Preselect { name, bundle_id })
                    }
                    _ => None,
                })
            }
            Answer::Dismiss => self.quiet_for(bundle, now),
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
        // Read once a second on a plain thread: drain what AppKit
        // autoreleases each time, rather than letting it build up.
        objc2::rc::autoreleasepool(|_| {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            let bundle_id = app.bundleIdentifier()?.to_string();
            let name = app.localizedName()?.to_string();
            Some(Frontmost { bundle_id, name })
        })
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
        // The microphone pausing within the same call, such as a mute,
        // brings no second offer for the app it was left for.
        let blip = start + Duration::from_secs(300);
        watcher.observe(&Signals::default(), false, blip);
        watcher.observe(&IN_USE(zoom()), false, blip);
        watcher.observe(&IN_USE(zoom()), false, blip + SETTLE);
        assert_eq!(watcher.prompt(), None);
        // A new call, once that quiet time has passed, is offered again.
        let later = start + SETTLE + SHOWN_FOR + QUIET_FOR;
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
        let offered = |watcher: &mut Watcher, at: Instant, app: Option<Frontmost>| {
            watcher.observe(&Signals::default(), false, at);
            watcher.observe(&IN_USE(app.clone()), false, at);
            watcher.observe(&IN_USE(app), false, at + SETTLE);
            watcher.prompt().map(|prompt| prompt.id)
        };
        let mut watcher = on();
        let id = offered(&mut watcher, start, zoom()).unwrap();
        // A stale answer changes nothing.
        assert_eq!(watcher.answer(id + 1, Answer::Start, start), None);
        assert_eq!(
            watcher.answer(id, Answer::Start, start),
            Some(Some(Preselect {
                name: "zoom.us".into(),
                bundle_id: "us.zoom.xos".into(),
            }))
        );
        assert_eq!(watcher.prompt(), None);

        // Not now covers the rest of that call for that app, not others.
        let at = start + Duration::from_secs(60);
        let id = offered(&mut watcher, at, zoom()).unwrap();
        assert_eq!(watcher.answer(id, Answer::Dismiss, at), None);
        assert_eq!(
            offered(&mut watcher, at + Duration::from_secs(60), zoom()),
            None
        );
        let facetime = Some(Frontmost {
            bundle_id: "com.apple.FaceTime".into(),
            name: "FaceTime".into(),
        });
        let id = offered(&mut watcher, at + Duration::from_secs(120), facetime).unwrap();
        watcher.answer(id, Answer::NotForThisApp, at);
        assert_eq!(watcher.settings().not_for, ["FaceTime"]);
        let at = at + QUIET_FOR + Duration::from_secs(1);
        assert!(
            offered(&mut watcher, at, zoom()).is_some(),
            "quiet time over"
        );
        let id = watcher.prompt().unwrap().id;
        watcher.answer(id, Answer::DontAskAgain, at);
        assert!(!watcher.enabled());
        assert_eq!(
            offered(&mut watcher, at + Duration::from_secs(60), zoom()),
            None
        );
    }

    #[test]
    fn saved_choices_come_back_named_and_still_skip_their_application() {
        let mut watcher = Watcher::default();
        watcher.restore(
            true,
            false,
            &[
                "us.zoom.xos".into(),
                "com.example.unknown".into(),
                "us.zoom.xos".into(),
            ],
        );
        assert!(watcher.enabled());
        assert_eq!(watcher.settings().not_for, ["Zoom"]);
        assert_eq!(watcher.not_for_ids(), ["us.zoom.xos"]);
        let start = Instant::now();
        watcher.observe(&IN_USE(zoom()), false, start);
        watcher.observe(&IN_USE(zoom()), false, start + SETTLE);
        assert_eq!(watcher.prompt(), None);
        // Every application an offer can be skipped for has a name.
        for bundle in MEETING.iter().chain(BROWSERS) {
            assert!(known_name(bundle).is_some(), "{bundle}");
        }
        watcher.restore(false, false, &[]);
        assert_eq!(watcher.settings(), &Settings::default());
    }

    #[test]
    fn starting_from_a_browser_offer_preselects_the_microphone_only() {
        let mut watcher = on();
        let start = Instant::now();
        let chrome = Some(Frontmost {
            bundle_id: "com.google.Chrome".into(),
            name: "Google Chrome".into(),
        });
        watcher.observe(&IN_USE(chrome.clone()), false, start);
        watcher.observe(&IN_USE(chrome), false, start + SETTLE);
        let id = watcher.prompt().unwrap().id;
        // Every tab's audio would come with the browser: the person adds it.
        assert_eq!(watcher.answer(id, Answer::Start, start), Some(None));
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

    #[test]
    fn auto_start_is_off_by_default_and_triggers_once_per_spell_when_enabled() {
        let mut watcher = Watcher::default();
        assert!(!watcher.auto_start());
        assert!(!watcher.watching());
        assert!(watcher.set_auto_start(true));
        assert!(watcher.watching());

        let start = Instant::now();
        let none = Signals::default();
        assert!(watcher
            .observe_with(&IN_USE(zoom()), false, true, start)
            .auto_start
            .is_none());
        let obs = watcher.observe_with(&IN_USE(zoom()), false, true, start + SETTLE);
        assert!(obs.auto_start.is_some());
        assert!(!obs.prompt_changed);
        assert_eq!(watcher.prompt(), None);

        // Same mic spell does not trigger auto-start again.
        assert!(watcher
            .observe_with(
                &IN_USE(zoom()),
                false,
                true,
                start + SETTLE + Duration::from_secs(5)
            )
            .auto_start
            .is_none());

        // Wait out QUIET_FOR and trigger again on a browser call.
        watcher.observe_with(&none, false, true, start + SETTLE + Duration::from_secs(6));
        watcher.observe_with(
            &none,
            false,
            true,
            start + SETTLE + Duration::from_secs(6) + QUIET_FOR,
        );
        let chrome = Some(Frontmost {
            bundle_id: "com.google.Chrome".into(),
            name: "Google Chrome".into(),
        });
        let next = start + SETTLE + Duration::from_secs(12) + QUIET_FOR;
        watcher.observe_with(&IN_USE(chrome.clone()), false, true, next);
        assert!(watcher
            .observe_with(&IN_USE(chrome), false, true, next + SETTLE)
            .auto_start
            .is_some());
    }

    #[test]
    fn auto_start_skips_when_unavailable_busy_skipped_or_unknown_app() {
        let facetime = || {
            Some(Frontmost {
                bundle_id: "com.apple.FaceTime".into(),
                name: "FaceTime".into(),
            })
        };
        let mut watcher = Watcher::default();
        watcher.restore(false, true, &["us.zoom.xos".into()]);
        let start = Instant::now();

        // Unavailable: keys missing.
        watcher.observe_with(&IN_USE(facetime()), false, false, start);
        assert!(watcher
            .observe_with(&IN_USE(facetime()), false, false, start + SETTLE)
            .auto_start
            .is_none());

        // Busy: session already active.
        let t2 = start + SETTLE + Duration::from_secs(10) + QUIET_FOR;
        watcher.observe_with(
            &Signals::default(),
            false,
            true,
            start + SETTLE + Duration::from_secs(1),
        );
        watcher.observe_with(&Signals::default(), false, true, t2);
        watcher.observe_with(&IN_USE(facetime()), true, true, t2 + Duration::from_secs(1));
        assert!(watcher
            .observe_with(
                &IN_USE(facetime()),
                true,
                true,
                t2 + Duration::from_secs(1) + SETTLE
            )
            .auto_start
            .is_none());

        // Skipped app or unknown app.
        let t3 = t2 + Duration::from_secs(20) + QUIET_FOR;
        watcher.observe_with(
            &Signals::default(),
            false,
            true,
            t2 + SETTLE + Duration::from_secs(2),
        );
        watcher.observe_with(&Signals::default(), false, true, t3);
        watcher.observe_with(&IN_USE(zoom()), false, true, t3 + Duration::from_secs(1));
        assert!(watcher
            .observe_with(
                &IN_USE(zoom()),
                false,
                true,
                t3 + Duration::from_secs(1) + SETTLE
            )
            .auto_start
            .is_none());

        let unknown = Some(Frontmost {
            bundle_id: "com.example.voice".into(),
            name: "Voice Memo".into(),
        });
        let t4 = t3 + Duration::from_secs(20) + QUIET_FOR;
        watcher.observe_with(
            &Signals::default(),
            false,
            true,
            t3 + SETTLE + Duration::from_secs(2),
        );
        watcher.observe_with(&Signals::default(), false, true, t4);
        watcher.observe_with(
            &IN_USE(unknown.clone()),
            false,
            true,
            t4 + Duration::from_secs(1),
        );
        assert!(watcher
            .observe_with(
                &IN_USE(unknown),
                false,
                true,
                t4 + Duration::from_secs(1) + SETTLE
            )
            .auto_start
            .is_none());
    }
}
