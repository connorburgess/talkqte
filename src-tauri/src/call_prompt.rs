//! "A call seems to be starting": a quiet offer to start a live session.
//!
//! Signals read on macOS without extra permissions:
//! - whether another process has a microphone running (Core Audio Process Object
//!   List on macOS 14.2+ for exact process bundle identifiers even in the
//!   background, falling back to the default input device's "running
//!   somewhere" property on macOS 14.0–14.1 or when unavailable),
//! - whether a camera device is active (CoreMediaIO "device is running
//!   somewhere", catching instant meeting preview screens even while muted),
//! - which application is frontmost (`NSWorkspace.frontmostApplication`).
//!
//! TalkQTE's own process identifier and bundle identifiers (`app.talkqte.*` and
//! `com.talkqte.*`) are ignored so TalkQTE never triggers on itself. When a call
//! signal settles (1.5 s when a known meeting app or browser is identified, 3 s
//! for generic microphone-only use), no TalkQTE session or microphone check
//! runs, and the person has turned the prompt on, the companion offers to start
//! a session with the microphone and, when a known call app or browser is
//! active, that application preselected. Nothing is captured, listed or sent by
//! the offer: it only opens the notebook's ordinary start. It never starts a
//! session by itself, and it shows once per spell of call activity.
//!
//! Nothing is read while the prompt is off. What is read is only local
//! metadata: whether the microphone or camera is in use and which app is using
//! it or in front — never audio, video frames, or screen content, and it stays
//! on this Mac. The on/off setting and the applications not to ask about are
//! kept in the settings file (`settings.rs`), the latter as bundle identifiers
//! only.

use serde::Serialize;
use std::time::{Duration, Instant};

/// How long generic microphone-only activity must settle before the offer, so a
/// brief dictation or a sound check does not raise it.
pub const SETTLE: Duration = Duration::from_secs(3);
/// Snappier settle when a known meeting app or browser is identified (mic or
/// camera preview), so instant meetings offer right at the preview screen.
pub const PREVIEW_SETTLE: Duration = Duration::from_millis(1500);
/// The offer goes away by itself after this long.
pub const SHOWN_FOR: Duration = Duration::from_secs(45);
/// How often the macOS adapter reads the signals while the prompt is on.
pub const POLL: Duration = Duration::from_millis(500);
/// After Not now, or an offer left to go away by itself, the same
/// application is not offered again for this long, so one call that briefly
/// releases the microphone (muting, a device change) is asked about once.
pub const QUIET_FOR: Duration = Duration::from_secs(20 * 60);

/// An application identified by macOS metadata (frontmost or active-mic
/// process). Metadata only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frontmost {
    pub bundle_id: String,
    pub name: String,
}

/// What the signals were at one read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Signals {
    /// Another process has a microphone input running.
    pub microphone_in_use: bool,
    /// A camera device is running somewhere (CoreMediaIO metadata).
    pub camera_in_use: bool,
    /// Non-self processes actively running audio input (Core Audio Process
    /// Object List on macOS 14.2+), if available.
    pub active_mic_apps: Vec<Frontmost>,
    /// The frontmost application, as macOS names it.
    pub frontmost: Option<Frontmost>,
}

/// How an application relates to a call.
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
    "com.hnc.Discord",
    "net.whatsapp.WhatsApp",
    "ru.keepcoder.Telegram",
    "org.whispersystems.signal-desktop",
    "app.tuple.app",
    "com.amazon.Amazon-Chime",
    "com.ringcentral.glip",
    "com.logmein.goto",
    "co.around.Around",
    "com.loom.desktop",
];
const BROWSERS: &[&str] = &[
    "com.google.Chrome",
    "com.apple.Safari",
    "company.thebrowser.Browser",
    "org.mozilla.firefox",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera",
    "app.zen-browser.zen",
    "company.thebrowser.dia",
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
        "com.hnc.Discord" => "Discord",
        "net.whatsapp.WhatsApp" => "WhatsApp",
        "ru.keepcoder.Telegram" => "Telegram",
        "org.whispersystems.signal-desktop" => "Signal",
        "app.tuple.app" => "Tuple",
        "com.amazon.Amazon-Chime" => "Amazon Chime",
        "com.ringcentral.glip" => "RingCentral",
        "com.logmein.goto" => "GoTo",
        "co.around.Around" => "Around",
        "com.loom.desktop" => "Loom",
        "com.google.Chrome" => "Google Chrome",
        "com.apple.Safari" => "Safari",
        "company.thebrowser.Browser" => "Arc",
        "org.mozilla.firefox" => "Firefox",
        "com.microsoft.edgemac" => "Microsoft Edge",
        "com.brave.Browser" => "Brave",
        "com.vivaldi.Vivaldi" => "Vivaldi",
        "com.operasoftware.Opera" => "Opera",
        "app.zen-browser.zen" => "Zen",
        "company.thebrowser.dia" => "Dia",
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

fn is_self_bundle(bundle_id: &str) -> bool {
    bundle_id == "com.talkqte.desktop"
        || bundle_id.starts_with("com.talkqte.")
        || bundle_id.starts_with("app.talkqte.")
}

#[cfg(any(target_os = "macos", test))]
fn is_self_process(pid: Option<u32>, bundle_id: Option<&str>, self_pid: u32) -> bool {
    pid == Some(self_pid) || bundle_id.is_some_and(is_self_bundle)
}

/// Maps helper subprocess bundle identifiers (such as
/// `com.google.Chrome.helper`) back to their known parent application when the
/// parent is a known meeting app or browser.
fn canonical_bundle_id(bundle_id: &str) -> &str {
    if kind(bundle_id).is_some() {
        return bundle_id;
    }
    MEETING
        .iter()
        .chain(BROWSERS)
        .copied()
        .find(|known| {
            bundle_id
                .strip_prefix(known)
                .is_some_and(|rest| rest.starts_with('.'))
        })
        .unwrap_or(bundle_id)
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessAudioState {
    pid: Option<u32>,
    bundle_id: Option<String>,
    name: Option<String>,
    running_input: bool,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ClassifiedProcesses {
    /// `Some(true)` if a non-self process has active audio input;
    /// `Some(false)` if only TalkQTE itself has active audio input;
    /// `None` if no process reported active audio input.
    other_mic_in_use: Option<bool>,
    active_mic_apps: Vec<Frontmost>,
}

#[cfg(any(target_os = "macos", test))]
fn classify_mic_processes(processes: &[ProcessAudioState], self_pid: u32) -> ClassifiedProcesses {
    let mut self_running = false;
    let mut other_running = false;
    let mut active_mic_apps: Vec<Frontmost> = Vec::new();

    for proc in processes {
        if !proc.running_input {
            continue;
        }
        if is_self_process(proc.pid, proc.bundle_id.as_deref(), self_pid) {
            self_running = true;
            continue;
        }
        other_running = true;
        let Some(raw_bundle) = proc.bundle_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let canonical = canonical_bundle_id(raw_bundle);
        if active_mic_apps
            .iter()
            .any(|existing| existing.bundle_id == canonical)
        {
            continue;
        }
        let name = if let Some(known) = known_name(canonical) {
            known.to_string()
        } else if canonical == raw_bundle {
            proc.name
                .as_deref()
                .filter(|name| !name.is_empty())
                .unwrap_or(canonical)
                .to_string()
        } else {
            canonical.to_string()
        };
        active_mic_apps.push(Frontmost {
            bundle_id: canonical.to_string(),
            name,
        });
    }

    let other_mic_in_use = if other_running {
        Some(true)
    } else if self_running {
        Some(false)
    } else {
        None
    };

    ClassifiedProcesses {
        other_mic_in_use,
        active_mic_apps,
    }
}

fn resolve_candidate(signals: &Signals) -> Option<(Frontmost, Kind)> {
    // 1. When the microphone is in use, prefer a known meeting app or browser
    // actively holding audio input (even if it is running in the background).
    if signals.microphone_in_use {
        let frontmost_id = signals
            .frontmost
            .as_ref()
            .map(|app| canonical_bundle_id(&app.bundle_id));
        let mut best: Option<(Frontmost, Kind, bool)> = None;
        for app in &signals.active_mic_apps {
            if is_self_bundle(&app.bundle_id) {
                continue;
            }
            let canonical = canonical_bundle_id(&app.bundle_id);
            let Some(app_kind) = kind(canonical) else {
                continue;
            };
            let is_front = frontmost_id == Some(canonical);
            let candidate = Frontmost {
                bundle_id: canonical.to_string(),
                name: if canonical == app.bundle_id {
                    app.name.clone()
                } else {
                    known_name(canonical).unwrap_or(canonical).to_string()
                },
            };
            let better = match &best {
                None => true,
                Some((_, best_kind, best_front)) => {
                    (app_kind == Kind::Meeting && *best_kind != Kind::Meeting)
                        || (app_kind == *best_kind && is_front && !*best_front)
                }
            };
            if better {
                best = Some((candidate, app_kind, is_front));
            }
        }
        if let Some((app, app_kind, _)) = best {
            return Some((app, app_kind));
        }
    }

    // 2. Fallback (macOS 14.0–14.1 without Process Object List, camera-only
    // preview screens with muted mic, or apps like FaceTime/Safari whose audio
    // runs in a system daemon): check the frontmost application.
    signals.frontmost.as_ref().and_then(|app| {
        if is_self_bundle(&app.bundle_id) {
            return None;
        }
        let canonical = canonical_bundle_id(&app.bundle_id);
        let app_kind = kind(canonical)?;
        Some((
            Frontmost {
                bundle_id: canonical.to_string(),
                name: app.name.clone(),
            },
            app_kind,
        ))
    })
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
    /// When the current spell of call activity began.
    in_use_since: Option<Instant>,
    /// Known meeting app or browser identified during the current spell,
    /// retained across brief frontmost switches during preview settle.
    pending_candidate: Option<(Frontmost, Kind)>,
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

    /// Turn the prompt on or off. Off clears any offer and what was seen.
    pub fn set_enabled(&mut self, enabled: bool) -> bool {
        let changed = self.settings.enabled != enabled;
        self.settings.enabled = enabled;
        if !enabled {
            self.in_use_since = None;
            self.pending_candidate = None;
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
    pub fn restore(&mut self, enabled: bool, not_for_ids: &[String]) {
        self.set_enabled(enabled);
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
    /// TalkQTE's own business, and that spell of use gets no offer. Returns
    /// whether the offer changed.
    pub fn observe(&mut self, signals: &Signals, busy: bool, now: Instant) -> bool {
        if !self.settings.enabled {
            return self.clear();
        }
        let current_candidate = resolve_candidate(signals);
        let call_active = signals.microphone_in_use
            || (signals.camera_in_use
                && (current_candidate.is_some()
                    || self.pending_candidate.is_some()
                    || self.prompt.is_some()));
        if busy {
            if self.in_use_since.is_some() || call_active {
                self.spent = true;
            }
            return self.clear();
        }
        if !call_active {
            self.in_use_since = None;
            self.pending_candidate = None;
            self.spent = false;
            return self.clear();
        }
        if let Some(ref candidate) = current_candidate {
            self.pending_candidate = Some(candidate.clone());
        }
        let since = *self.in_use_since.get_or_insert(now);
        if let Some((_, shown, bundle)) = &self.prompt {
            if now.saturating_duration_since(*shown) >= SHOWN_FOR {
                // Left to go away: as Not now, for the rest of this call.
                let bundle = bundle.clone();
                self.quiet_for(bundle, now);
                return self.clear();
            }
            return false;
        }
        self.quiet.retain(|(_, until)| *until > now);
        let candidate = current_candidate.or_else(|| self.pending_candidate.clone());
        let settle = if candidate.is_some() {
            PREVIEW_SETTLE
        } else {
            SETTLE
        };
        if self.spent || now.saturating_duration_since(since) < settle {
            return false;
        }
        self.spent = true;
        let bundle = candidate.as_ref().map(|(app, _)| app.bundle_id.clone());
        if bundle
            .as_ref()
            .is_some_and(|bundle| self.not_for_ids.contains(bundle))
            || self.quiet.iter().any(|(quiet, _)| *quiet == bundle)
        {
            return false;
        }
        self.next_id += 1;
        let prompt = Prompt {
            application: candidate.as_ref().map(|(app, _)| app.name.clone()),
            kind: candidate.as_ref().map(|(_, kind)| *kind),
            id: self.next_id,
        };
        self.prompt = Some((prompt, now, bundle));
        true
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

/// Local macOS metadata signals, read without any permission:
/// - Core Audio Process Object List (macOS 14.2+) for per-process mic input,
///   falling back to the default input device's "running somewhere" property,
/// - CoreMediaIO device "running somewhere" for camera preview detection,
/// - `NSWorkspace.frontmostApplication` for the frontmost app.
///
/// Neither opens the microphone or camera, nor reads audio, video frames, or
/// window content.
#[cfg(target_os = "macos")]
pub mod native {
    use super::{classify_mic_processes, Frontmost, ProcessAudioState, Signals};
    use std::ffi::{c_char, c_void, CStr};

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
    const PROCESS_OBJECT_LIST: u32 = code(b"prs#");
    const PROCESS_PID: u32 = code(b"ppid");
    const PROCESS_BUNDLE_ID: u32 = code(b"pbid");
    const PROCESS_IS_RUNNING_INPUT: u32 = code(b"piri");
    const CMIO_HARDWARE_DEVICES: u32 = code(b"dev#");
    const UTF8_ENCODING: u32 = 0x0800_0100;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
        ) -> i32;

        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreMediaIO", kind = "framework")]
    extern "C" {
        fn CMIOObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
        ) -> i32;

        fn CMIOObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: u32,
            data_used: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFStringGetLength(the_string: *const c_void) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            the_string: *const c_void,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
    }

    struct CfOwned(*const c_void);
    impl Drop for CfOwned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `self.0` was returned by Core Audio's Copy/Get rule
                // for `kAudioProcessPropertyBundleID` and must be released once.
                unsafe { CFRelease(self.0) };
            }
        }
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

    fn read_i32(object: u32, selector: u32) -> Option<i32> {
        let address = Address {
            selector,
            scope: GLOBAL,
            element: 0,
        };
        let mut value = 0_i32;
        let mut size = std::mem::size_of::<i32>() as u32;
        // SAFETY: a property read into an i32 of the size given; no capture.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut value as *mut i32).cast(),
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<i32>()).then_some(value)
    }

    fn read_cfstring(object: u32, selector: u32) -> Option<String> {
        let address = Address {
            selector,
            scope: GLOBAL,
            element: 0,
        };
        let mut cf_str: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        // SAFETY: `AudioObjectGetPropertyData` writes one retained CFStringRef
        // on success, which `CfOwned` releases when dropped.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut cf_str as *mut *const c_void).cast(),
            )
        };
        if status != 0 || size as usize != std::mem::size_of::<*const c_void>() || cf_str.is_null()
        {
            return None;
        }
        let owned = CfOwned(cf_str);
        // SAFETY: `owned.0` is a valid non-null CFStringRef.
        let len = unsafe { CFStringGetLength(owned.0) };
        if len <= 0 {
            return None;
        }
        // SAFETY: querying UTF-8 byte bound for a valid CFStringRef.
        let max_bytes = unsafe { CFStringGetMaximumSizeForEncoding(len, UTF8_ENCODING) };
        if max_bytes <= 0 {
            return None;
        }
        let mut buf = vec![0_u8; max_bytes as usize + 1];
        // SAFETY: `buf` has room for `max_bytes` plus the NUL terminator.
        let ok = unsafe {
            CFStringGetCString(
                owned.0,
                buf.as_mut_ptr().cast::<c_char>(),
                buf.len() as isize,
                UTF8_ENCODING,
            )
        };
        if ok == 0 {
            return None;
        }
        CStr::from_bytes_until_nul(&buf)
            .ok()
            .and_then(|s| s.to_str().ok())
            .map(str::to_owned)
    }

    fn read_u32_list(object: u32, selector: u32) -> Option<Vec<u32>> {
        let address = Address {
            selector,
            scope: GLOBAL,
            element: 0,
        };
        let mut size = 0_u32;
        // SAFETY: queries byte length of an AudioObjectID array property.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(object, &address, 0, std::ptr::null(), &mut size)
        };
        if status != 0 {
            return None;
        }
        let elem_size = std::mem::size_of::<u32>();
        let count = size as usize / elem_size;
        if count == 0 {
            return Some(Vec::new());
        }
        let mut list = vec![0_u32; count];
        // SAFETY: `list` holds `count` u32 values matching `size` bytes.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                list.as_mut_ptr().cast(),
            )
        };
        if status != 0 {
            return None;
        }
        list.truncate(size as usize / elem_size);
        Some(list)
    }

    fn read_cmio_u32(object: u32, selector: u32) -> Option<u32> {
        let address = Address {
            selector,
            scope: GLOBAL,
            element: 0,
        };
        let mut value = 0_u32;
        let mut used = 0_u32;
        // SAFETY: reads one CMIO u32 property into `value`.
        let status = unsafe {
            CMIOObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                std::mem::size_of::<u32>() as u32,
                &mut used,
                (&mut value as *mut u32).cast(),
            )
        };
        (status == 0 && used as usize == std::mem::size_of::<u32>()).then_some(value)
    }

    fn read_cmio_devices() -> Vec<u32> {
        let address = Address {
            selector: CMIO_HARDWARE_DEVICES,
            scope: GLOBAL,
            element: 0,
        };
        let mut size = 0_u32;
        // SAFETY: queries byte length of CMIODeviceID array.
        let status = unsafe {
            CMIOObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size)
        };
        if status != 0 {
            return Vec::new();
        }
        let elem_size = std::mem::size_of::<u32>();
        let count = size as usize / elem_size;
        if count == 0 {
            return Vec::new();
        }
        let mut list = vec![0_u32; count];
        let mut used = 0_u32;
        // SAFETY: `list` holds `count` u32 device IDs matching `size` bytes.
        let status = unsafe {
            CMIOObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                size,
                &mut used,
                list.as_mut_ptr().cast(),
            )
        };
        if status != 0 {
            return Vec::new();
        }
        list.truncate(used as usize / elem_size);
        list
    }

    /// Whether any CoreMediaIO camera device is currently running somewhere.
    /// Metadata only; requires no camera permission.
    pub fn camera_in_use() -> bool {
        read_cmio_devices().into_iter().any(|device| {
            device != 0
                && read_cmio_u32(device, RUNNING_SOMEWHERE).is_some_and(|running| running != 0)
        })
    }

    /// Whether any process has the default input device running.
    pub fn default_input_running_somewhere() -> bool {
        read_u32(SYSTEM_OBJECT, DEFAULT_INPUT)
            .filter(|device| *device != 0)
            .and_then(|device| read_u32(device, RUNNING_SOMEWHERE))
            .is_some_and(|running| running != 0)
    }

    /// Reads Core Audio Process Objects (macOS 14.2+), returning `None` when
    /// unavailable (e.g. macOS 14.0–14.1) so callers can fall back cleanly.
    fn read_process_audio_states() -> Option<Vec<ProcessAudioState>> {
        use objc2_app_kit::NSRunningApplication;
        let objects = read_u32_list(SYSTEM_OBJECT, PROCESS_OBJECT_LIST)?;
        objc2::rc::autoreleasepool(|_| {
            let mut states = Vec::with_capacity(objects.len());
            for obj in objects {
                let running_input =
                    read_u32(obj, PROCESS_IS_RUNNING_INPUT).is_some_and(|running| running != 0);
                if !running_input {
                    continue;
                }
                let raw_pid = read_i32(obj, PROCESS_PID);
                let pid = raw_pid.and_then(|p| u32::try_from(p).ok());
                let mut bundle_id = read_cfstring(obj, PROCESS_BUNDLE_ID);
                let mut name = None;
                if let Some(app_pid) = raw_pid.filter(|p| *p > 0) {
                    if let Some(running) =
                        NSRunningApplication::runningApplicationWithProcessIdentifier(app_pid)
                    {
                        if bundle_id.is_none() {
                            bundle_id = running.bundleIdentifier().map(|id| id.to_string());
                        }
                        name = running.localizedName().map(|n| n.to_string());
                    }
                }
                states.push(ProcessAudioState {
                    pid,
                    bundle_id,
                    name,
                    running_input,
                });
            }
            Some(states)
        })
    }

    /// Whether any non-TalkQTE process has a microphone running.
    pub fn microphone_in_use() -> bool {
        if let Some(states) = read_process_audio_states() {
            let classified = classify_mic_processes(&states, std::process::id());
            return match classified.other_mic_in_use {
                Some(in_use) => in_use,
                None => default_input_running_somewhere(),
            };
        }
        default_input_running_somewhere()
    }

    pub fn frontmost() -> Option<Frontmost> {
        use objc2_app_kit::NSWorkspace;
        // Read on a plain thread: drain what AppKit autoreleases each time,
        // rather than letting it build up.
        objc2::rc::autoreleasepool(|_| {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            let bundle_id = app.bundleIdentifier()?.to_string();
            let name = app.localizedName()?.to_string();
            Some(Frontmost { bundle_id, name })
        })
    }

    pub fn read() -> Signals {
        let (microphone_in_use, active_mic_apps) = match read_process_audio_states() {
            Some(states) => {
                let classified = classify_mic_processes(&states, std::process::id());
                let mic_in_use = match classified.other_mic_in_use {
                    Some(in_use) => in_use,
                    None => default_input_running_somewhere(),
                };
                (mic_in_use, classified.active_mic_apps)
            }
            None => (default_input_running_somewhere(), Vec::new()),
        };
        Signals {
            microphone_in_use,
            camera_in_use: camera_in_use(),
            active_mic_apps,
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

    fn in_use(frontmost: Option<Frontmost>) -> Signals {
        Signals {
            microphone_in_use: true,
            frontmost,
            ..Signals::default()
        }
    }

    #[test]
    fn nothing_is_offered_while_the_prompt_is_off_which_it_is_by_default() {
        let mut watcher = Watcher::default();
        assert!(!watcher.enabled());
        let start = Instant::now();
        for second in 0..60 {
            watcher.observe(&in_use(zoom()), false, start + Duration::from_secs(second));
        }
        assert_eq!(watcher.prompt(), None);
    }

    #[test]
    fn a_call_app_using_the_microphone_for_a_moment_is_offered_once_then_goes_away() {
        let mut watcher = on();
        let start = Instant::now();
        assert!(!watcher.observe(&in_use(zoom()), false, start));
        // Not before it has settled.
        assert!(!watcher.observe(&in_use(zoom()), false, start + Duration::from_secs(1)));
        assert!(watcher.observe(&in_use(zoom()), false, start + PREVIEW_SETTLE));
        let prompt = watcher.prompt().unwrap().clone();
        assert_eq!(prompt.application.as_deref(), Some("zoom.us"));
        assert_eq!(prompt.kind, Some(Kind::Meeting));
        // It goes away by itself and does not come back in the same call.
        assert!(watcher.observe(&in_use(zoom()), false, start + PREVIEW_SETTLE + SHOWN_FOR));
        assert_eq!(watcher.prompt(), None);
        for second in 0..120 {
            watcher.observe(
                &in_use(zoom()),
                false,
                start + Duration::from_secs(100 + second),
            );
        }
        assert_eq!(watcher.prompt(), None);
        // The microphone pausing within the same call, such as a mute,
        // brings no second offer for the app it was left for.
        let blip = start + Duration::from_secs(300);
        watcher.observe(&Signals::default(), false, blip);
        watcher.observe(&in_use(zoom()), false, blip);
        watcher.observe(&in_use(zoom()), false, blip + PREVIEW_SETTLE);
        assert_eq!(watcher.prompt(), None);
        // A new call, once that quiet time has passed, is offered again.
        let later = start + PREVIEW_SETTLE + SHOWN_FOR + QUIET_FOR;
        watcher.observe(&Signals::default(), false, later);
        watcher.observe(&in_use(zoom()), false, later);
        assert!(watcher.observe(&in_use(zoom()), false, later + PREVIEW_SETTLE));
        assert!(watcher.prompt().unwrap().id > prompt.id);
    }

    #[test]
    fn the_microphone_stopping_or_talkqte_listening_withdraws_the_offer() {
        let mut watcher = on();
        let start = Instant::now();
        watcher.observe(&in_use(zoom()), false, start);
        watcher.observe(&in_use(zoom()), false, start + PREVIEW_SETTLE);
        assert!(watcher.prompt().is_some());
        assert!(watcher.observe(&Signals::default(), false, start + SETTLE * 2));
        assert_eq!(watcher.prompt(), None);
        // TalkQTE's own session uses the microphone: no offer then, nor for
        // the rest of that spell after the session ends.
        let next = start + Duration::from_secs(100);
        watcher.observe(&in_use(zoom()), true, next);
        watcher.observe(&in_use(zoom()), true, next + SETTLE);
        assert_eq!(watcher.prompt(), None);
        watcher.observe(&in_use(zoom()), false, next + SETTLE * 3);
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
        watcher.observe(&in_use(notes.clone()), false, start);
        watcher.observe(&in_use(notes), false, start + SETTLE);
        let prompt = watcher.prompt().unwrap();
        assert_eq!((prompt.application.as_deref(), prompt.kind), (None, None));

        let mut watcher = on();
        let chrome = Some(Frontmost {
            bundle_id: "com.google.Chrome".into(),
            name: "Google Chrome".into(),
        });
        watcher.observe(&in_use(chrome.clone()), false, start);
        watcher.observe(&in_use(chrome), false, start + PREVIEW_SETTLE);
        assert_eq!(watcher.prompt().unwrap().kind, Some(Kind::Browser));
    }

    #[test]
    fn the_answers_start_dismiss_skip_an_app_or_turn_the_prompt_off() {
        let start = Instant::now();
        let offered = |watcher: &mut Watcher, at: Instant, app: Option<Frontmost>| {
            watcher.observe(&Signals::default(), false, at);
            watcher.observe(&in_use(app.clone()), false, at);
            watcher.observe(&in_use(app), false, at + SETTLE);
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
        watcher.observe(&in_use(zoom()), false, start);
        watcher.observe(&in_use(zoom()), false, start + PREVIEW_SETTLE);
        assert_eq!(watcher.prompt(), None);
        // Every application an offer can be skipped for has a name.
        for bundle in MEETING.iter().chain(BROWSERS) {
            assert!(known_name(bundle).is_some(), "{bundle}");
        }
        watcher.restore(false, &[]);
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
        watcher.observe(&in_use(chrome.clone()), false, start);
        watcher.observe(&in_use(chrome), false, start + PREVIEW_SETTLE);
        let id = watcher.prompt().unwrap().id;
        // Every tab's audio would come with the browser: the person adds it.
        assert_eq!(watcher.answer(id, Answer::Start, start), Some(None));
    }

    #[test]
    fn turning_it_off_withdraws_the_offer_at_once() {
        let mut watcher = on();
        let start = Instant::now();
        watcher.observe(&in_use(zoom()), false, start);
        watcher.observe(&in_use(zoom()), false, start + PREVIEW_SETTLE);
        assert!(watcher.set_enabled(false));
        assert_eq!(watcher.prompt(), None);
    }

    #[test]
    fn background_meeting_app_holding_mic_while_another_app_is_frontmost() {
        let mut watcher = on();
        let start = Instant::now();
        let signals = Signals {
            microphone_in_use: true,
            camera_in_use: false,
            active_mic_apps: vec![Frontmost {
                bundle_id: "com.hnc.Discord".into(),
                name: "Discord".into(),
            }],
            frontmost: Some(Frontmost {
                bundle_id: "com.example.fictional-editor".into(),
                name: "Fictional Editor".into(),
            }),
        };

        assert!(!watcher.observe(&signals, false, start));
        assert!(watcher.observe(&signals, false, start + PREVIEW_SETTLE));
        let prompt = watcher.prompt().unwrap().clone();
        assert_eq!(prompt.application.as_deref(), Some("Discord"));
        assert_eq!(prompt.kind, Some(Kind::Meeting));
        assert_eq!(
            watcher.answer(prompt.id, Answer::Start, start + PREVIEW_SETTLE),
            Some(Some(Preselect {
                name: "Discord".into(),
                bundle_id: "com.hnc.Discord".into(),
            }))
        );

        // If both a browser and a meeting app hold the mic, prefer the meeting app.
        let later = start + Duration::from_secs(60);
        watcher.observe(&Signals::default(), false, later);
        let both = Signals {
            microphone_in_use: true,
            camera_in_use: false,
            active_mic_apps: vec![
                Frontmost {
                    bundle_id: "com.google.Chrome".into(),
                    name: "Google Chrome".into(),
                },
                Frontmost {
                    bundle_id: "com.microsoft.teams2".into(),
                    name: "Microsoft Teams".into(),
                },
            ],
            frontmost: Some(Frontmost {
                bundle_id: "com.google.Chrome".into(),
                name: "Google Chrome".into(),
            }),
        };
        assert!(!watcher.observe(&both, false, later));
        assert!(watcher.observe(&both, false, later + PREVIEW_SETTLE));
        let prompt = watcher.prompt().unwrap();
        assert_eq!(prompt.application.as_deref(), Some("Microsoft Teams"));
        assert_eq!(prompt.kind, Some(Kind::Meeting));

        // Background browser holding mic while user Cmd-Tabbed to Terminal.
        let much_later = later + QUIET_FOR + Duration::from_secs(60);
        watcher.observe(&Signals::default(), false, much_later);
        let bg_browser = Signals {
            microphone_in_use: true,
            camera_in_use: false,
            active_mic_apps: vec![Frontmost {
                bundle_id: "company.thebrowser.Browser".into(),
                name: "Arc".into(),
            }],
            frontmost: Some(Frontmost {
                bundle_id: "com.apple.Terminal".into(),
                name: "Terminal".into(),
            }),
        };
        assert!(!watcher.observe(&bg_browser, false, much_later));
        assert!(watcher.observe(&bg_browser, false, much_later + PREVIEW_SETTLE));
        let prompt = watcher.prompt().unwrap();
        assert_eq!(prompt.application.as_deref(), Some("Arc"));
        assert_eq!(prompt.kind, Some(Kind::Browser));
    }

    #[test]
    fn camera_preview_triggers_with_muted_mic_and_ignores_unknown_camera_apps() {
        let mut watcher = on();
        let start = Instant::now();

        // Unknown app using camera with muted mic does not trigger a call offer.
        let photo_booth = Signals {
            microphone_in_use: false,
            camera_in_use: true,
            active_mic_apps: Vec::new(),
            frontmost: Some(Frontmost {
                bundle_id: "com.apple.PhotoBooth".into(),
                name: "Photo Booth".into(),
            }),
        };
        for ms in (0..=4000).step_by(500) {
            assert!(!watcher.observe(&photo_booth, false, start + Duration::from_millis(ms)));
        }
        assert_eq!(watcher.prompt(), None);

        // Known browser on an instant Google Meet preview screen (camera active, mic muted).
        let meet_preview = Signals {
            microphone_in_use: false,
            camera_in_use: true,
            active_mic_apps: Vec::new(),
            frontmost: Some(Frontmost {
                bundle_id: "com.google.Chrome".into(),
                name: "Google Chrome".into(),
            }),
        };
        let t1 = start + Duration::from_secs(10);
        assert!(!watcher.observe(&meet_preview, false, t1));
        assert!(!watcher.observe(&meet_preview, false, t1 + Duration::from_secs(1)));
        assert!(watcher.observe(&meet_preview, false, t1 + PREVIEW_SETTLE));
        let prompt = watcher.prompt().unwrap().clone();
        assert_eq!(prompt.application.as_deref(), Some("Google Chrome"));
        assert_eq!(prompt.kind, Some(Kind::Browser));

        // Unmuting the mic during the call keeps the spell active without re-offering.
        let unmuted = Signals {
            microphone_in_use: true,
            camera_in_use: true,
            active_mic_apps: vec![Frontmost {
                bundle_id: "com.google.Chrome".into(),
                name: "Google Chrome".into(),
            }],
            frontmost: meet_preview.frontmost.clone(),
        };
        assert!(!watcher.observe(&unmuted, false, t1 + Duration::from_secs(5)));
        assert_eq!(watcher.prompt(), Some(&prompt));

        // Closing the preview (both camera and mic off) withdraws the offer.
        assert!(watcher.observe(&Signals::default(), false, t1 + Duration::from_secs(6)));
        assert_eq!(watcher.prompt(), None);
    }

    #[test]
    fn self_pid_and_self_bundle_are_excluded() {
        let self_pid = 4242;
        assert!(is_self_process(Some(self_pid), None, self_pid));
        assert!(is_self_process(
            Some(9999),
            Some("app.talkqte.desktop"),
            self_pid
        ));
        assert!(is_self_process(
            Some(9999),
            Some("app.talkqte.mac.helper"),
            self_pid
        ));
        assert!(is_self_process(
            Some(9999),
            Some("com.talkqte.desktop"),
            self_pid
        ));
        assert!(!is_self_process(Some(9999), Some("us.zoom.xos"), self_pid));
        assert!(!is_self_process(
            Some(9999),
            Some("com.google.Chrome"),
            self_pid
        ));

        // When only TalkQTE (by PID or bundle) is running input, classify reports false.
        let only_self = classify_mic_processes(
            &[
                ProcessAudioState {
                    pid: Some(self_pid),
                    bundle_id: None,
                    name: None,
                    running_input: true,
                },
                ProcessAudioState {
                    pid: Some(5001),
                    bundle_id: Some("app.talkqte.helper".into()),
                    name: Some("TalkQTE Helper".into()),
                    running_input: true,
                },
            ],
            self_pid,
        );
        assert_eq!(only_self.other_mic_in_use, Some(false));
        assert!(only_self.active_mic_apps.is_empty());

        // TalkQTE + Chrome helper: TalkQTE excluded, Chrome helper canonicalized & deduplicated.
        let mixed = classify_mic_processes(
            &[
                ProcessAudioState {
                    pid: Some(self_pid),
                    bundle_id: Some("com.talkqte.desktop".into()),
                    name: Some("TalkQTE".into()),
                    running_input: true,
                },
                ProcessAudioState {
                    pid: Some(6001),
                    bundle_id: Some("com.google.Chrome.helper".into()),
                    name: Some("Google Chrome Helper".into()),
                    running_input: true,
                },
                ProcessAudioState {
                    pid: Some(6002),
                    bundle_id: Some("com.google.Chrome.helper.renderer".into()),
                    name: Some("Google Chrome Helper (Renderer)".into()),
                    running_input: true,
                },
                ProcessAudioState {
                    pid: Some(6003),
                    bundle_id: Some("us.zoom.xos".into()),
                    name: Some("zoom.us".into()),
                    running_input: false,
                },
            ],
            self_pid,
        );
        assert_eq!(mixed.other_mic_in_use, Some(true));
        assert_eq!(
            mixed.active_mic_apps,
            vec![Frontmost {
                bundle_id: "com.google.Chrome".into(),
                name: "Google Chrome".into(),
            }]
        );

        // Watcher also ignores self bundle IDs if ever passed in Signals.
        let mut watcher = on();
        let start = Instant::now();
        let self_signals = Signals {
            microphone_in_use: true,
            camera_in_use: false,
            active_mic_apps: vec![Frontmost {
                bundle_id: "app.talkqte.desktop".into(),
                name: "TalkQTE".into(),
            }],
            frontmost: Some(Frontmost {
                bundle_id: "com.talkqte.desktop".into(),
                name: "TalkQTE".into(),
            }),
        };
        watcher.observe(&self_signals, false, start);
        watcher.observe(&self_signals, false, start + SETTLE);
        let prompt = watcher.prompt().unwrap();
        assert_eq!((prompt.application.as_deref(), prompt.kind), (None, None));
    }

    #[test]
    fn preview_settle_is_faster_than_generic_mic_settle() {
        assert_eq!(PREVIEW_SETTLE, Duration::from_millis(1500));
        assert_eq!(SETTLE, Duration::from_secs(3));
        let start = Instant::now();

        // Known meeting app triggers at 1.5 s.
        let mut meeting_watcher = on();
        let slack = Some(Frontmost {
            bundle_id: "com.tinyspeck.slackmacgap".into(),
            name: "Slack".into(),
        });
        assert!(!meeting_watcher.observe(&in_use(slack.clone()), false, start));
        assert!(!meeting_watcher.observe(
            &in_use(slack.clone()),
            false,
            start + Duration::from_secs(1)
        ));
        assert!(meeting_watcher.observe(&in_use(slack), false, start + PREVIEW_SETTLE));
        assert_eq!(
            meeting_watcher.prompt().unwrap().application.as_deref(),
            Some("Slack")
        );

        // Generic mic-only (unknown app) waits the full 3 s.
        let mut generic_watcher = on();
        let unknown = Some(Frontmost {
            bundle_id: "com.example.dictation".into(),
            name: "Dictation".into(),
        });
        assert!(!generic_watcher.observe(&in_use(unknown.clone()), false, start));
        assert!(!generic_watcher.observe(&in_use(unknown.clone()), false, start + PREVIEW_SETTLE));
        assert!(!generic_watcher.observe(
            &in_use(unknown.clone()),
            false,
            start + Duration::from_millis(2500)
        ));
        assert!(generic_watcher.observe(&in_use(unknown), false, start + SETTLE));
        assert_eq!(generic_watcher.prompt().unwrap().application, None);
    }

    #[test]
    fn all_meeting_and_browser_providers_have_names_and_kinds() {
        let expected_meetings = [
            ("us.zoom.xos", "Zoom"),
            ("com.microsoft.teams2", "Microsoft Teams"),
            ("com.microsoft.teams", "Microsoft Teams"),
            ("com.apple.FaceTime", "FaceTime"),
            ("com.cisco.webexmeetingsapp", "Webex"),
            ("Cisco-Systems.Spark", "Webex"),
            ("com.tinyspeck.slackmacgap", "Slack"),
            ("com.hnc.Discord", "Discord"),
            ("net.whatsapp.WhatsApp", "WhatsApp"),
            ("ru.keepcoder.Telegram", "Telegram"),
            ("org.whispersystems.signal-desktop", "Signal"),
            ("app.tuple.app", "Tuple"),
            ("com.amazon.Amazon-Chime", "Amazon Chime"),
            ("com.ringcentral.glip", "RingCentral"),
            ("com.logmein.goto", "GoTo"),
            ("co.around.Around", "Around"),
            ("com.loom.desktop", "Loom"),
        ];
        for (bundle, name) in expected_meetings {
            assert_eq!(kind(bundle), Some(Kind::Meeting), "{bundle}");
            assert_eq!(known_name(bundle), Some(name), "{bundle}");
        }

        let expected_browsers = [
            ("com.google.Chrome", "Google Chrome"),
            ("com.apple.Safari", "Safari"),
            ("company.thebrowser.Browser", "Arc"),
            ("org.mozilla.firefox", "Firefox"),
            ("com.microsoft.edgemac", "Microsoft Edge"),
            ("com.brave.Browser", "Brave"),
            ("com.vivaldi.Vivaldi", "Vivaldi"),
            ("com.operasoftware.Opera", "Opera"),
            ("app.zen-browser.zen", "Zen"),
            ("company.thebrowser.dia", "Dia"),
        ];
        for (bundle, name) in expected_browsers {
            assert_eq!(kind(bundle), Some(Kind::Browser), "{bundle}");
            assert_eq!(known_name(bundle), Some(name), "{bundle}");
        }

        assert_eq!(MEETING.len(), expected_meetings.len());
        assert_eq!(BROWSERS.len(), expected_browsers.len());
    }
}
