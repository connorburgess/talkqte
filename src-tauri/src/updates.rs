//! Updates: what a feed offers, and the rule that no update is offered or
//! applied while a call, microphone check, or voice dictation is active.
//! The design, and what turning signed updates on needs, is in
//! docs/release-path.md#updates.
//!
//! The feed is Tauri's updater format (`latest.json`), so
//! `tauri-plugin-updater` reads the same file: a version, notes, a date and,
//! per platform, the download and its minisign signature.

use serde::Deserialize;
use std::collections::BTreeMap;

/// Returned when a build has no minisign public key or HTTPS endpoint configured.
pub const NOT_CONFIGURED_MESSAGE: &str = "Updates are not configured in this build";

/// Maximum length of release notes shown in Settings.
const MAX_NOTES_CHARS: usize = 1_000;

/// The update setting. Kept for offline feed-reader unit tests.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateSettings {
    pub enabled: bool,
    pub feed: Option<&'static str>,
}

/// Every build today: no checks until configured.
#[cfg_attr(not(test), allow(dead_code))]
pub const SETTINGS: UpdateSettings = UpdateSettings {
    enabled: false,
    feed: None,
};

#[cfg_attr(not(test), allow(dead_code))]
impl UpdateSettings {
    /// The feed to ask, only when the setting is on and the feed is https.
    pub fn feed_to_check(&self) -> Option<&'static str> {
        self.feed
            .filter(|feed| self.enabled && feed.starts_with("https://"))
    }
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Deserialize)]
struct RawFeed {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    platforms: BTreeMap<String, RawPlatform>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Deserialize)]
struct RawPlatform {
    signature: String,
    url: String,
}

/// An update this copy could install.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: String,
    pub notes: Option<String>,
    pub published: Option<String>,
    pub url: String,
    pub signature: String,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub enum FeedError {
    Unreadable(String),
    BadVersion(String),
    NotHttps(String),
    MissingSignature,
}

impl std::fmt::Display for FeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(why) => write!(f, "the update feed cannot be read: {why}"),
            Self::BadVersion(version) => {
                write!(f, "the update feed names an unusable version {version:?}")
            }
            Self::NotHttps(url) => write!(f, "the update download is not https: {url}"),
            Self::MissingSignature => f.write_str("the update download has no signature"),
        }
    }
}

/// The Tauri updater's name for the platform this copy was built for.
#[cfg_attr(not(test), allow(dead_code))]
pub fn platform() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-aarch64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x86_64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "windows-aarch64"
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else {
        "linux-x86_64"
    }
}

/// `MAJOR.MINOR.PATCH`, the only form the release pre-flight allows.
#[cfg_attr(not(test), allow(dead_code))]
fn version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.strip_prefix('v').unwrap_or(text).split('.');
    let mut next = || parts.next()?.parse::<u64>().ok();
    let parsed = (next()?, next()?, next()?);
    parts.next().is_none().then_some(parsed)
}

/// What a feed offers this copy: `None` when it is not newer or lists no
/// download for `platform`; an error when the feed itself is unusable.
#[cfg_attr(not(test), allow(dead_code))]
pub fn offer(feed: &str, current: &str, platform: &str) -> Result<Option<Offer>, FeedError> {
    let raw: RawFeed =
        serde_json::from_str(feed).map_err(|error| FeedError::Unreadable(error.to_string()))?;
    let offered =
        version(&raw.version).ok_or_else(|| FeedError::BadVersion(raw.version.clone()))?;
    let running = version(current).ok_or_else(|| FeedError::BadVersion(current.to_owned()))?;
    if offered <= running {
        return Ok(None);
    }
    let Some(download) = raw.platforms.get(platform) else {
        return Ok(None);
    };
    if !download.url.starts_with("https://") {
        return Err(FeedError::NotHttps(download.url.clone()));
    }
    if download.signature.trim().is_empty() {
        return Err(FeedError::MissingSignature);
    }
    Ok(Some(Offer {
        version: raw.version.trim_start_matches('v').to_owned(),
        notes: raw.notes,
        published: raw.pub_date,
        url: download.url.clone(),
        signature: download.signature.clone(),
    }))
}

/// Why an update must wait, if it must.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    /// A live session is starting, running, paused or still finishing.
    LiveSession,
    /// The microphone is starting, on (including monitoring without a
    /// session) or stopping, or its state could not be read.
    Microphone,
    /// An application's audio is being captured.
    ApplicationAudio,
    /// Voice dictation in Notes or Focus is starting, listening, or stopping.
    Dictation,
}

/// What to do with an offer now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing is listening: the person may be shown the update.
    Offer(Offer),
    /// Kept until the session stops; nothing is shown or downloaded.
    Deferred(Hold),
    /// No update.
    None,
}

/// Holds an offer found while a call was in progress until it ends. It never
/// applies anything itself: installing waits for the person's choice, and a
/// restart is only offered when nothing is listening.
#[derive(Debug, Default)]
pub struct Deferral {
    pending: Option<Offer>,
}

impl Deferral {
    /// An offer arrived, or the person asked to install one.
    pub fn consider(&mut self, offer: Option<Offer>, hold: Option<Hold>) -> Decision {
        if let Some(offer) = offer {
            // A newer offer replaces an older pending one.
            self.pending = Some(offer);
        }
        match (hold, self.pending.take()) {
            (_, None) => Decision::None,
            (Some(hold), Some(offer)) => {
                self.pending = Some(offer);
                Decision::Deferred(hold)
            }
            (None, Some(offer)) => Decision::Offer(offer),
        }
    }

    /// Called after Stop, and whenever the app checks again: the held offer,
    /// once nothing is listening any more.
    pub fn released(&mut self, hold: Option<Hold>) -> Decision {
        self.consider(None, hold)
    }

    pub fn pending(&self) -> Option<&Offer> {
        self.pending.as_ref()
    }
}

/// Why an update must wait right now, from the same state Stop changes.
pub(crate) fn hold_for(
    live_session_open: bool,
    microphone: Option<crate::microphone::Status>,
    application_audio: bool,
    dictation_active: bool,
) -> Option<Hold> {
    use crate::microphone::Status;
    if live_session_open {
        return Some(Hold::LiveSession);
    }
    if application_audio {
        return Some(Hold::ApplicationAudio);
    }
    if dictation_active {
        return Some(Hold::Dictation);
    }
    match microphone {
        Some(Status::Off | Status::Error) => None,
        // Starting, listening, stopping, or busy enough that its state could
        // not be read without waiting: hold.
        _ => Some(Hold::Microphone),
    }
}

impl crate::Runtime {
    /// Why an update must wait, given the microphone and dictation state.
    pub(crate) fn update_hold(
        &self,
        microphone: Option<crate::microphone::Status>,
        dictation_active: bool,
    ) -> Option<Hold> {
        hold_for(
            self.live_session_open(),
            microphone,
            self.live_source.is_some() || self.source_session.is_some(),
            dictation_active,
        )
    }
}

/// Optional minisign public key injected at compile time for signed releases.
pub fn compile_time_pubkey() -> Option<&'static str> {
    option_env!("TALKQTE_UPDATER_PUBKEY")
        .or(option_env!("TAURI_UPDATER_PUBKEY"))
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

/// Effective minisign public key for this build, from compile-time env or `tauri.conf.json`.
pub fn effective_pubkey(config: &tauri::Config) -> Option<String> {
    if let Some(key) = compile_time_pubkey() {
        return Some(key.to_owned());
    }
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// Whether `tauri.conf.json` configures at least one HTTPS updater endpoint.
pub fn has_https_endpoint(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|endpoints| {
            !endpoints.is_empty()
                && endpoints.iter().all(|entry| {
                    entry
                        .as_str()
                        .is_some_and(|url| url.starts_with("https://"))
                })
        })
}

/// Whether this build can verify and fetch updates from HTTPS endpoints.
pub fn is_configured(config: &tauri::Config) -> bool {
    effective_pubkey(config).is_some() && has_https_endpoint(config)
}

/// Sanitizes and bounds release notes before exposing them to the notebook UI.
pub fn sanitize_notes(notes: Option<&str>) -> Option<String> {
    let raw = notes?;
    let mut cleaned = String::with_capacity(raw.len().min(MAX_NOTES_CHARS));
    for ch in raw.chars() {
        if ch == '\n'
            || ch == '\t'
            || (!ch.is_control() && !('\u{202a}'..='\u{202e}').contains(&ch))
        {
            if cleaned.chars().count() >= MAX_NOTES_CHARS {
                cleaned.push('…');
                break;
            }
            cleaned.push(ch);
        }
    }
    let trimmed = cleaned.trim().to_owned();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Maps `tauri-plugin-updater` errors to plain-language UI messages without paths or URLs.
pub fn map_updater_error(error: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::EmptyEndpoints | Error::InsecureTransportProtocol => NOT_CONFIGURED_MESSAGE.into(),
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            "The update signature could not be verified. The current version was kept.".into()
        }
        Error::ReleaseNotFound => "No published release was found yet.".into(),
        Error::TargetNotFound(_)
        | Error::TargetsNotFound(_)
        | Error::UnsupportedArch
        | Error::UnsupportedOs => "No update package is available for this platform.".into(),
        Error::Reqwest(_) | Error::Network(_) => {
            "Could not reach the update server. Check your connection and try again.".into()
        }
        Error::AuthenticationFailed => {
            "Administrator permission is required to replace TalkQTE.".into()
        }
        Error::TempDirNotOnSameMountPoint | Error::PreviousAppNotRestored(_) => {
            "Could not install the update safely. The current version was kept.".into()
        }
        Error::InvalidUpdaterFormat | Error::BinaryNotFoundInArchive => {
            "The downloaded update package could not be used. The current version was kept.".into()
        }
        _ => "Could not complete the update. Try again later.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::microphone::Status;

    const FEED: &str = include_str!("../../scripts/fixtures/update-feed.json");

    fn fake(version: &str, url: &str, signature: &str) -> String {
        serde_json::json!({
            "version": version,
            "platforms": { "darwin-aarch64": { "url": url, "signature": signature } }
        })
        .to_string()
    }

    #[test]
    fn updates_are_off_in_every_build() {
        assert_eq!(SETTINGS.feed_to_check(), None);
        assert_eq!(
            SETTINGS,
            UpdateSettings {
                enabled: false,
                feed: None
            }
        );
        let on = UpdateSettings {
            enabled: true,
            feed: Some("https://downloads.example.invalid/latest.json"),
        };
        assert_eq!(on.feed_to_check(), on.feed);
        let plain = UpdateSettings {
            enabled: true,
            feed: Some("http://downloads.example.invalid/latest.json"),
        };
        assert_eq!(plain.feed_to_check(), None);
        let off = UpdateSettings {
            enabled: false,
            ..on
        };
        assert_eq!(off.feed_to_check(), None);
    }

    #[test]
    fn the_fake_feed_offers_a_newer_version_for_each_mac() {
        for platform in ["darwin-aarch64", "darwin-x86_64"] {
            let offer = offer(FEED, "0.1.0", platform).unwrap().unwrap();
            assert_eq!(offer.version, "0.2.0");
            assert!(offer.url.starts_with("https://downloads.example.invalid/"));
            assert!(!offer.signature.is_empty());
            assert_eq!(offer.published.as_deref(), Some("2026-12-01T09:00:00Z"));
        }
        assert_eq!(offer(FEED, "0.1.0", "windows-x86_64"), Ok(None));
        // This copy's own platform reads the feed the same way.
        let own = offer(FEED, "0.1.0", platform()).unwrap();
        assert_eq!(own.is_some(), platform().starts_with("darwin-"));
    }

    #[test]
    fn the_same_or_an_older_version_is_not_offered() {
        assert_eq!(offer(FEED, "0.2.0", "darwin-aarch64"), Ok(None));
        assert_eq!(offer(FEED, "0.10.0", "darwin-aarch64"), Ok(None));
        assert_eq!(offer(FEED, "1.0.0", "darwin-aarch64"), Ok(None));
        let v = fake("v0.1.1", "https://x.example.invalid/a", "sig");
        assert_eq!(
            offer(&v, "0.1.0", "darwin-aarch64")
                .unwrap()
                .unwrap()
                .version,
            "0.1.1"
        );
    }

    #[test]
    fn an_unusable_feed_is_an_error_not_an_offer() {
        assert!(matches!(
            offer("<html>", "0.1.0", "darwin-aarch64"),
            Err(FeedError::Unreadable(_))
        ));
        for bad in ["0.2", "0.2.0-beta", "0.2.0.1", "latest"] {
            assert_eq!(
                offer(
                    &fake(bad, "https://x.example.invalid/a", "s"),
                    "0.1.0",
                    "darwin-aarch64"
                ),
                Err(FeedError::BadVersion(bad.into()))
            );
        }
        assert_eq!(
            offer(
                &fake("0.2.0", "http://x.example.invalid/a", "s"),
                "0.1.0",
                "darwin-aarch64"
            ),
            Err(FeedError::NotHttps("http://x.example.invalid/a".into()))
        );
        assert_eq!(
            offer(
                &fake("0.2.0", "https://x.example.invalid/a", " "),
                "0.1.0",
                "darwin-aarch64"
            ),
            Err(FeedError::MissingSignature)
        );
    }

    #[test]
    fn anything_listening_holds_an_update() {
        assert_eq!(hold_for(false, Some(Status::Off), false, false), None);
        assert_eq!(hold_for(false, Some(Status::Error), false, false), None);
        assert_eq!(
            hold_for(true, Some(Status::Off), false, false),
            Some(Hold::LiveSession)
        );
        for status in [Status::Starting, Status::Listening, Status::Stopping] {
            assert_eq!(
                hold_for(false, Some(status), false, false),
                Some(Hold::Microphone)
            );
        }
        // A microphone whose state cannot be read without waiting is busy.
        assert_eq!(hold_for(false, None, false, false), Some(Hold::Microphone));
        assert_eq!(
            hold_for(false, Some(Status::Off), true, false),
            Some(Hold::ApplicationAudio)
        );
        assert_eq!(
            hold_for(false, Some(Status::Off), false, true),
            Some(Hold::Dictation)
        );
    }

    #[test]
    fn an_offer_during_a_call_waits_for_stop() {
        let mut deferral = Deferral::default();
        let found = offer(FEED, "0.1.0", "darwin-aarch64").unwrap();
        assert_eq!(
            deferral.consider(found.clone(), Some(Hold::LiveSession)),
            Decision::Deferred(Hold::LiveSession)
        );
        assert_eq!(deferral.pending(), found.as_ref());
        // Still listening on a later check: still held, and still kept.
        assert_eq!(
            deferral.released(Some(Hold::Microphone)),
            Decision::Deferred(Hold::Microphone)
        );
        // After Stop the person sees it once.
        assert_eq!(deferral.released(None), Decision::Offer(found.unwrap()));
        assert_eq!(deferral.released(None), Decision::None);
    }

    #[test]
    fn a_newer_offer_replaces_a_held_one_and_nothing_listening_offers_at_once() {
        let mut deferral = Deferral::default();
        let older = offer(
            &fake("0.2.0", "https://x.example.invalid/a", "s"),
            "0.1.0",
            "darwin-aarch64",
        )
        .unwrap();
        let newer = offer(
            &fake("0.3.0", "https://x.example.invalid/b", "s"),
            "0.1.0",
            "darwin-aarch64",
        )
        .unwrap();
        deferral.consider(older, Some(Hold::LiveSession));
        deferral.consider(newer.clone(), Some(Hold::LiveSession));
        assert_eq!(
            deferral.released(None),
            Decision::Offer(newer.clone().unwrap())
        );
        assert_eq!(
            deferral.consider(newer.clone(), None),
            Decision::Offer(newer.unwrap())
        );
        assert_eq!(deferral.consider(None, None), Decision::None);
    }

    #[test]
    fn the_runtime_holds_while_a_live_session_is_open() {
        let mut runtime = crate::Runtime::default();
        assert_eq!(runtime.update_hold(Some(Status::Off), false), None);
        assert_eq!(
            runtime.update_hold(Some(Status::Listening), false),
            Some(Hold::Microphone)
        );
        assert_eq!(
            runtime.update_hold(Some(Status::Off), true),
            Some(Hold::Dictation)
        );
        runtime.engine.state.live = true;
        runtime.engine.state.status = crate::engine::Status::Running;
        assert_eq!(
            runtime.update_hold(Some(Status::Off), false),
            Some(Hold::LiveSession)
        );
        runtime.engine.state.status = crate::engine::Status::Paused;
        assert_eq!(
            runtime.update_hold(Some(Status::Off), false),
            Some(Hold::LiveSession)
        );
        runtime.engine.state.status = crate::engine::Status::Ended;
        assert_eq!(runtime.update_hold(Some(Status::Off), false), None);
    }

    #[test]
    fn unconfigured_pubkey_and_notes_sanitization_are_safe() {
        let mut config = tauri::Config::default();
        assert!(!is_configured(&config));
        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "endpoints": ["https://github.com/connorburgess/talkqte/releases/latest/download/latest.json"],
                "pubkey": ""
            }),
        );
        assert_eq!(effective_pubkey(&config), None);
        assert!(has_https_endpoint(&config));
        assert!(!is_configured(&config));

        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "endpoints": ["https://github.com/connorburgess/talkqte/releases/latest/download/latest.json"],
                "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IGZpY3Rpb25hbCBwdWJrZXk="
            }),
        );
        assert!(is_configured(&config));

        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "endpoints": ["http://insecure.example.invalid/latest.json"],
                "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IGZpY3Rpb25hbCBwdWJrZXk="
            }),
        );
        assert!(!has_https_endpoint(&config));
        assert!(!is_configured(&config));

        assert_eq!(sanitize_notes(None), None);
        assert_eq!(sanitize_notes(Some("   \x00\u{202e}  ")), None);
        assert_eq!(
            sanitize_notes(Some("  Bug fixes\u{202e} and stability.\x07  ")),
            Some("Bug fixes and stability.".into())
        );
    }
}
