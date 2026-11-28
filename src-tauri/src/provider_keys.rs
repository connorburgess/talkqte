//! The person's own provider keys: Deepgram or ElevenLabs for transcription,
//! and API keys for cue decisions and meeting notes (Anthropic, OpenAI, or Gemini).
//!
//! Keys live only in the system's secret store under the service
//! [`SERVICE`]: the login Keychain on macOS (generic passwords), Windows
//! Credential Manager (generic credentials, [`windows`]) and the desktop
//! keyring through the Secret Service on Linux ([`secret_service`]). Where
//! there is no such store (a Linux system without a keyring), keys cannot be
//! saved and the notebook says so; they are never kept anywhere else. They
//! are never written to a file, never logged, never
//! put in an error and never sent back to the webview: the notebook receives
//! only whether each key is set, set and checked, or rejected. A key's shape
//! is checked before it is stored. Checking a key is an explicit action that
//! makes one read-only request to its provider; storing one sends nothing.
//!
//! Tests use [`MemoryStore`] and a scripted [`Probe`]; none of them reaches the
//! Keychain or the network.

use serde::{Deserialize, Serialize};
use std::{
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};
use zeroize::Zeroizing;

#[cfg(target_os = "linux")]
pub mod secret_service;
#[cfg(windows)]
pub mod windows;

/// The Keychain service every TalkQTE provider key is stored under.
pub const SERVICE: &str = "app.talkqte.provider-key";

/// The providers a key can be entered for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Deepgram,
    ElevenLabs,
    Anthropic,
    OpenAi,
    Gemini,
}

impl Provider {
    pub const ALL: [Self; 5] = [
        Self::Deepgram,
        Self::ElevenLabs,
        Self::Anthropic,
        Self::OpenAi,
        Self::Gemini,
    ];

    /// The Keychain account name for this provider's key.
    pub fn account(self) -> &'static str {
        match self {
            Self::Deepgram => "deepgram",
            Self::ElevenLabs => "elevenlabs",
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Deepgram => "Deepgram",
            Self::ElevenLabs => "ElevenLabs",
            Self::Anthropic => "Anthropic",
            Self::OpenAi => "OpenAI",
            Self::Gemini => "Gemini",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Deepgram => 0,
            Self::ElevenLabs => 1,
            Self::Anthropic => 2,
            Self::OpenAi => 3,
            Self::Gemini => 4,
        }
    }
}

/// A key in memory. Its text is wiped on drop and never formatted.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// The key text, for the one request header that carries it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    #[cfg(test)]
    pub fn for_test(text: &str) -> Self {
        Self(Zeroizing::new(text.to_string()))
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

/// Checks a pasted key's shape and returns it trimmed. Surrounding whitespace
/// from a paste is removed; anything else outside the expected shape is
/// refused, so a stray word or a different credential is never stored.
pub fn validate(provider: Provider, text: &str) -> Result<Secret, KeyError> {
    let key = text.trim();
    let ok = match provider {
        // Console API keys only, as the lab accepts: classic sk-ant-api… and
        // account-linked sk-ant-usr-…. Admin and other sk-ant- credentials are
        // refused.
        Provider::Anthropic => {
            (key.starts_with("sk-ant-api") || key.starts_with("sk-ant-usr-"))
                && !key.starts_with("sk-ant-admin")
                && (40..=256).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        }
        // Deepgram API keys are 40 hexadecimal characters today; a little room
        // either side, letters and digits only.
        Provider::Deepgram => {
            (32..=128).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric())
        }
        // ElevenLabs API keys start with `sk_` (current keys) or are 32-64
        // hexadecimal characters (legacy keys), without stray spaces or prose.
        Provider::ElevenLabs => {
            (key.starts_with("sk_")
                && (32..=256).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')))
                || ((32..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_hexdigit()))
        }
        // Standard OpenAI API keys start with `sk-` (including `sk-proj-`, etc.).
        // Reject `sk-ant-` so Anthropic keys are refused here.
        Provider::OpenAi => {
            key.starts_with("sk-")
                && !key.starts_with("sk-ant-")
                && (20..=256).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        }
        // Google AI Studio API keys start with `AIza`.
        Provider::Gemini => {
            key.starts_with("AIza")
                && (30..=128).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        }
    };
    if ok {
        Ok(Secret(Zeroizing::new(key.to_string())))
    } else {
        Err(KeyError::Shape(provider))
    }
}

/// Fixed, key-free failures. The message is what the notebook shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    Shape(Provider),
    Store,
    /// There is no secret store on this system to keep keys in.
    NoStore,
    NotSet(Provider),
    Unreachable(Provider),
}

impl KeyError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Shape(Provider::Anthropic) => {
                "That does not look like an Anthropic API key. It starts with sk-ant-api."
            }
            Self::Shape(Provider::Deepgram) => {
                "That does not look like a Deepgram API key. It is letters and digits only."
            }
            Self::Shape(Provider::ElevenLabs) => {
                "That does not look like an ElevenLabs API key. It starts with sk_ (or is a 32-character hex key)."
            }
            Self::Shape(Provider::OpenAi) => {
                "That does not look like an OpenAI API key. It starts with sk-."
            }
            Self::Shape(Provider::Gemini) => {
                "That does not look like a Gemini API key. It starts with AIza."
            }
            Self::Store => store_failure_message(),
            Self::NoStore => {
                "This system has no keyring TalkQTE can use, so keys cannot be saved here yet. Nothing was changed."
            }
            Self::NotSet(Provider::Anthropic) => "No Anthropic key is set.",
            Self::NotSet(Provider::Deepgram) => "No Deepgram key is set.",
            Self::NotSet(Provider::ElevenLabs) => "No ElevenLabs key is set.",
            Self::NotSet(Provider::OpenAi) => "No OpenAI key is set.",
            Self::NotSet(Provider::Gemini) => "No Gemini key is set.",
            Self::Unreachable(Provider::Anthropic) => {
                "Anthropic could not be reached to check the key. Nothing was changed."
            }
            Self::Unreachable(Provider::Deepgram) => {
                "Deepgram could not be reached to check the key. Nothing was changed."
            }
            Self::Unreachable(Provider::ElevenLabs) => {
                "ElevenLabs could not be reached to check the key. Nothing was changed."
            }
            Self::Unreachable(Provider::OpenAi) => {
                "OpenAI could not be reached to check the key. Nothing was changed."
            }
            Self::Unreachable(Provider::Gemini) => {
                "Gemini could not be reached to check the key. Nothing was changed."
            }
        }
    }
}

impl From<KeyError> for String {
    fn from(error: KeyError) -> Self {
        error.message().to_string()
    }
}

/// What the store failure message names, per platform.
fn store_failure_message() -> &'static str {
    if cfg!(windows) {
        "Windows Credential Manager could not be used. Nothing was changed."
    } else if cfg!(target_os = "linux") {
        "The keyring could not be used. Unlock it or allow access, then try again. Nothing was changed."
    } else {
        "The Keychain could not be used. Nothing was changed."
    }
}

/// A store that could not be used. It carries no detail by design beyond
/// whether a store exists at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The store exists but refused or failed the operation.
    Failed,
    /// There is no store on this system (no keyring service to reach).
    Unavailable,
}

/// Which secret store keeps the keys, as the notebook names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoreKind {
    Keychain,
    CredentialManager,
    SecretService,
    /// Held in memory only: tests, and platforms with no store implemented.
    Memory,
}

/// Where keys are kept: the platform's store in the app; memory in tests.
pub trait SecretStore: Send + Sync {
    fn kind(&self) -> StoreKind {
        StoreKind::Memory
    }
    /// Whether a key is stored, without needing to read it where the store
    /// can tell (no unlock prompt just to show the settings).
    fn contains(&self, account: &str) -> Result<bool, StoreError> {
        Ok(self.get(account)?.is_some())
    }
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError>;
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError>;
    fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// The login Keychain, through Security.framework's generic passwords.
#[cfg(target_os = "macos")]
pub struct Keychain;

#[cfg(target_os = "macos")]
impl SecretStore for Keychain {
    fn kind(&self) -> StoreKind {
        StoreKind::Keychain
    }

    fn contains(&self, account: &str) -> Result<bool, StoreError> {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(account)
            .load_attributes(true)
            .search()
        {
            Ok(results) => Ok(!results.is_empty()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            Err(_) => Err(StoreError::Failed),
        }
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(SERVICE, account) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::Failed)?;
                Ok(Some(Secret(Zeroizing::new(text.to_string()))))
            }
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err(StoreError::Failed),
        }
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        // Delete any existing item first so saving replaces stale ACLs (for
        // example from an earlier unsigned build or `/usr/bin/security`) with
        // a fresh item owned by this binary.
        self.delete(account)?;
        security_framework::passwords::set_generic_password(
            SERVICE,
            account,
            secret.expose().as_bytes(),
        )
        .map_err(|_| StoreError::Failed)
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        match security_framework::passwords::delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err(StoreError::Failed),
        }
    }
}

/// `errSecItemNotFound` from Security.framework's SecBase.h.
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Keys held in memory only, where nothing is kept past quit: tests, and a
/// platform with no store implemented (none that TalkQTE builds for).
#[derive(Default)]
pub struct MemoryStore(Mutex<Vec<(String, Secret)>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        let items = self.0.lock().map_err(|_| StoreError::Failed)?;
        Ok(items
            .iter()
            .find(|(name, _)| name == account)
            .map(|(_, secret)| secret.clone()))
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        let mut items = self.0.lock().map_err(|_| StoreError::Failed)?;
        items.retain(|(name, _)| name != account);
        items.push((account.to_string(), secret.clone()));
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.0
            .lock()
            .map_err(|_| StoreError::Failed)?
            .retain(|(name, _)| name != account);
        Ok(())
    }
}

/// What the notebook may know about one key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyState {
    NotSet,
    Set,
    /// The provider refused the key, at a check or during a session.
    Rejected,
    /// The Keychain could not be read, so whether a key is stored is not
    /// known. Nothing is attempted with it.
    Unreadable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub state: KeyState,
    /// The provider accepted the key at the last check in this app run.
    pub verified: bool,
}

/// Which store holds the keys, and whether this system has it at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub kind: StoreKind,
    /// False when there is no store to use on this system: both keys then
    /// read as unreadable and none can be saved.
    pub available: bool,
}

/// All provider keys' states, the whole payload the notebook receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysStatus {
    pub deepgram: KeyStatus,
    pub elevenlabs: KeyStatus,
    pub anthropic: KeyStatus,
    pub openai: KeyStatus,
    pub gemini: KeyStatus,
    /// True when no transcription key is set or no cue provider key is set:
    /// what a first-run screen asks for.
    pub any_missing: bool,
    pub store: StoreStatus,
}

impl KeysStatus {
    pub fn of(&self, provider: Provider) -> KeyStatus {
        match provider {
            Provider::Deepgram => self.deepgram,
            Provider::ElevenLabs => self.elevenlabs,
            Provider::Anthropic => self.anthropic,
            Provider::OpenAi => self.openai,
            Provider::Gemini => self.gemini,
        }
    }
}

/// The provider's answer to a key check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeResult {
    Accepted,
    Rejected,
    Unreachable,
}

/// One read-only, authenticated request that proves a key works.
pub trait Probe: Send + Sync {
    fn check(&self, provider: Provider, key: &Secret) -> ProbeResult;
}

#[derive(Clone, Copy, Default)]
struct Memo {
    /// Whether a key is stored, once looked up; None until then.
    present: Option<bool>,
    rejected: bool,
    verified: bool,
    revision: u64,
}

/// In-memory identity only: never serialized, logged, or derived from key text.
#[derive(Clone)]
pub(crate) struct CredentialRevision {
    owner: Arc<()>,
    provider: Provider,
    revision: u64,
}

/// A non-cloneable reader owned by one serial adapter or stream.
/// Only its rejection handle can be shared; it cannot acquire credentials.
pub(crate) struct RequestKey {
    keys: &'static Keys,
    provider: Provider,
    revision: Arc<Mutex<Option<CredentialRevision>>>,
}
pub(crate) struct RequestRejection {
    keys: &'static Keys,
    revision: Arc<Mutex<Option<CredentialRevision>>>,
}
impl RequestKey {
    pub fn rejection_handler(&self) -> RequestRejection {
        RequestRejection {
            keys: self.keys,
            revision: self.revision.clone(),
        }
    }
    pub fn get(&mut self) -> Result<Secret, KeyError> {
        let result = self.keys.get_with_revision(self.provider);
        let mut receipt = self
            .revision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *receipt = result.as_ref().ok().map(|(_, revision)| revision.clone());
        result.map(|(key, _)| key)
    }
}
impl RequestRejection {
    pub fn mark_rejected(&self) {
        let revision = self
            .revision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(revision) = revision {
            self.keys.mark_rejected(&revision);
        }
    }
}

/// The key store plus what this app run has learned about each key.
pub struct Keys {
    store: Box<dyn SecretStore>,
    probe: Box<dyn Probe>,
    memo: Mutex<[Memo; 5]>,
    owner: Arc<()>,
}

impl Keys {
    pub fn new(store: Box<dyn SecretStore>, probe: Box<dyn Probe>) -> Self {
        Self {
            store,
            probe,
            memo: Mutex::new([Memo::default(); 5]),
            owner: Arc::new(()),
        }
    }

    fn memo(&self) -> std::sync::MutexGuard<'_, [Memo; 5]> {
        self.memo
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn present(&self, provider: Provider) -> Result<bool, KeyError> {
        let mut memo = self.memo();
        self.present_locked(provider, &mut memo[provider.index()])
    }

    fn present_locked(&self, provider: Provider, memo: &mut Memo) -> Result<bool, KeyError> {
        if let Some(present) = memo.present {
            return Ok(present);
        }
        let present = self
            .store
            .contains(provider.account())
            .map_err(store_error)?;
        memo.present = Some(present);
        Ok(present)
    }

    fn key_status(&self, provider: Provider) -> (KeyStatus, bool) {
        let mut entries = self.memo();
        let memo = &mut entries[provider.index()];
        let present = self.present_locked(provider, memo);
        let no_store = present == Err(KeyError::NoStore);
        let status = KeyStatus {
            state: match (present, memo.rejected) {
                (Err(_), _) => KeyState::Unreadable,
                (Ok(false), _) => KeyState::NotSet,
                (Ok(true), true) => KeyState::Rejected,
                (Ok(true), false) => KeyState::Set,
            },
            verified: present == Ok(true) && memo.verified && !memo.rejected,
        };
        (status, no_store)
    }

    /// All keys' states, read from the store again, so a key deleted or
    /// added outside TalkQTE is seen.
    pub fn status(&self) -> KeysStatus {
        for memo in self.memo().iter_mut() {
            memo.present = None;
        }
        let (deepgram, deepgram_no_store) = self.key_status(Provider::Deepgram);
        let (elevenlabs, elevenlabs_no_store) = self.key_status(Provider::ElevenLabs);
        let (anthropic, anthropic_no_store) = self.key_status(Provider::Anthropic);
        let (openai, openai_no_store) = self.key_status(Provider::OpenAi);
        let (gemini, gemini_no_store) = self.key_status(Provider::Gemini);
        let stt_missing =
            deepgram.state == KeyState::NotSet && elevenlabs.state == KeyState::NotSet;
        let cue_missing = anthropic.state == KeyState::NotSet
            && openai.state == KeyState::NotSet
            && gemini.state == KeyState::NotSet;
        KeysStatus {
            deepgram,
            elevenlabs,
            anthropic,
            openai,
            gemini,
            any_missing: stt_missing || cue_missing,
            store: StoreStatus {
                kind: self.store.kind(),
                available: !(deepgram_no_store
                    || elevenlabs_no_store
                    || anthropic_no_store
                    || openai_no_store
                    || gemini_no_store),
            },
        }
    }

    /// Stores a new key or replaces the old one, after the shape check. It is
    /// not checked with the provider until the person asks.
    pub fn set(&self, provider: Provider, text: &str) -> Result<KeysStatus, KeyError> {
        let secret = validate(provider, text)?;
        {
            let mut memo = self.memo();
            let entry = &mut memo[provider.index()];
            // Retire old work even if the platform write fails ambiguously.
            entry.revision = entry.revision.checked_add(1).ok_or(KeyError::Store)?;
            entry.verified = false;
            self.store
                .set(provider.account(), &secret)
                .map_err(store_error)?;
            entry.present = Some(true);
            entry.rejected = false;
        }
        Ok(self.status())
    }

    pub fn remove(&self, provider: Provider) -> Result<KeysStatus, KeyError> {
        {
            let mut memo = self.memo();
            let entry = &mut memo[provider.index()];
            entry.revision = entry.revision.checked_add(1).ok_or(KeyError::Store)?;
            entry.verified = false;
            self.store.delete(provider.account()).map_err(store_error)?;
            entry.present = Some(false);
            entry.rejected = false;
        }
        Ok(self.status())
    }

    /// The stored key, for the one request that uses it. Never returned to
    /// the webview.
    pub fn get(&self, provider: Provider) -> Result<Secret, KeyError> {
        self.get_with_revision(provider).map(|(secret, _)| secret)
    }

    pub(crate) fn get_with_revision(
        &self,
        provider: Provider,
    ) -> Result<(Secret, CredentialRevision), KeyError> {
        // Store read and identity capture cannot straddle set/remove. Never
        // retain this mutex during a provider request or response wait.
        let mut memo = self.memo();
        let secret = self.store.get(provider.account()).map_err(store_error)?;
        let entry = &mut memo[provider.index()];
        entry.present = Some(secret.is_some());
        let revision = CredentialRevision {
            owner: self.owner.clone(),
            provider,
            revision: entry.revision,
        };
        secret
            .map(|secret| (secret, revision))
            .ok_or(KeyError::NotSet(provider))
    }

    pub(crate) fn request_key(&'static self, provider: Provider) -> RequestKey {
        RequestKey {
            keys: self,
            provider,
            revision: Arc::new(Mutex::new(None)),
        }
    }

    /// Metadata-only readiness fixtures inject an auth observation without
    /// retrieving a fake or platform secret. Not available in production.
    #[cfg(test)]
    pub(crate) fn revision_for_test(&self, provider: Provider) -> CredentialRevision {
        CredentialRevision {
            owner: self.owner.clone(),
            provider,
            revision: self.memo()[provider.index()].revision,
        }
    }

    pub fn is_set(&self, provider: Provider) -> bool {
        self.present(provider).unwrap_or(false)
    }

    /// Asks the provider whether the stored key works, with one read-only
    /// request. An unreachable provider changes nothing.
    pub fn test(&self, provider: Provider) -> Result<KeysStatus, KeyError> {
        let (secret, revision) = self.get_with_revision(provider)?;
        let result = self.probe.check(provider, &secret);
        drop(secret);
        if result == ProbeResult::Unreachable {
            return Err(KeyError::Unreachable(provider));
        }
        self.apply_result(&revision, result);
        Ok(self.status())
    }

    fn apply_result(&self, revision: &CredentialRevision, result: ProbeResult) {
        let mut memo = self.memo();
        let entry = &mut memo[revision.provider.index()];
        if !Arc::ptr_eq(&revision.owner, &self.owner) || revision.revision != entry.revision {
            return;
        }
        match result {
            ProbeResult::Accepted => {
                entry.rejected = false;
                entry.verified = true;
            }
            ProbeResult::Rejected => {
                entry.rejected = true;
                entry.verified = false;
            }
            ProbeResult::Unreachable => {}
        }
    }

    /// The provider refused the key during a session (401 or 403).
    pub(crate) fn mark_rejected(&self, revision: &CredentialRevision) {
        self.apply_result(revision, ProbeResult::Rejected);
    }
}

fn store_error(error: StoreError) -> KeyError {
    match error {
        StoreError::Failed => KeyError::Store,
        StoreError::Unavailable => KeyError::NoStore,
    }
}

/// The real check: one authenticated GET that lists the account's projects
/// (Deepgram) or models (Anthropic). Neither transcribes nor generates, so
/// neither is billed. TLS with the bundled web roots, as Granola uses.
pub struct NetworkProbe;

/// The API version the lab's pinned Anthropic SDK sends; the in-app cue
/// requests use the same one.
pub const ANTHROPIC_VERSION: &str = "2026-10-21";

impl Probe for NetworkProbe {
    fn check(&self, provider: Provider, key: &Secret) -> ProbeResult {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .https_only(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent("TalkQTE")
            .build()
            .into();
        let response = match provider {
            Provider::Deepgram => agent
                .get("https://api.deepgram.com/v1/projects")
                .header(
                    "Authorization",
                    Zeroizing::new(format!("Token {}", key.expose())).as_str(),
                )
                .call(),
            Provider::ElevenLabs => agent
                .get("https://api.elevenlabs.io/v1/user")
                .header("xi-api-key", key.expose())
                .call(),
            Provider::Anthropic => agent
                .get("https://api.anthropic.com/v1/models?limit=1")
                .header("x-api-key", key.expose())
                .header("anthropic-version", ANTHROPIC_VERSION)
                .call(),
            Provider::OpenAi => agent
                .get("https://api.openai.com/v1/models")
                .header(
                    "Authorization",
                    Zeroizing::new(format!("Bearer {}", key.expose())).as_str(),
                )
                .call(),
            // Never pass the key in the query string so it cannot leak into URLs or logs.
            Provider::Gemini => agent
                .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
                .header("x-goog-api-key", key.expose())
                .call(),
        };
        // The body is never read: only the status matters, and nothing the
        // provider says reaches a log or the notebook.
        match response.map(|response| response.status().as_u16()) {
            Ok(200) => ProbeResult::Accepted,
            Ok(401 | 403) => ProbeResult::Rejected,
            _ => ProbeResult::Unreachable,
        }
    }
}

/// This app run's keys: the platform's store in the app, memory in tests,
/// so no test can read or change a real key.
pub fn global() -> &'static Keys {
    static KEYS: std::sync::OnceLock<Keys> = std::sync::OnceLock::new();
    KEYS.get_or_init(|| {
        #[cfg(all(target_os = "macos", not(test)))]
        let store: Box<dyn SecretStore> = Box::new(Keychain);
        #[cfg(all(windows, not(test)))]
        let store: Box<dyn SecretStore> = Box::new(windows::CredentialManager::new(SERVICE));
        #[cfg(all(target_os = "linux", not(test)))]
        let store: Box<dyn SecretStore> = Box::new(secret_service::SecretService::new(SERVICE));
        #[cfg(any(test, not(any(target_os = "macos", windows, target_os = "linux"))))]
        let store: Box<dyn SecretStore> = Box::new(MemoryStore::default());
        #[cfg(not(test))]
        let probe: Box<dyn Probe> = Box::new(NetworkProbe);
        #[cfg(test)]
        let probe: Box<dyn Probe> = Box::new(NoNetwork);
        Keys::new(store, probe)
    })
}

/// Tests never reach a provider: every check is unreachable.
#[cfg(test)]
struct NoNetwork;

#[cfg(test)]
impl Probe for NoNetwork {
    fn check(&self, _: Provider, _: &Secret) -> ProbeResult {
        ProbeResult::Unreachable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const ANTHROPIC: &str = "sk-ant-api03-FICTIONALfictional0123456789abcdefghij-_XYZ";
    const DEEPGRAM: &str = "0123456789abcdef0123456789abcdef01234567";
    const ELEVENLABS: &str = "sk_fictional0123456789abcdef0123456789abcdef01234567";
    const ELEVENLABS_HEX: &str = "0123456789abcdef0123456789abcdef";
    const OPENAI: &str = "sk-proj-FICTIONALfictional0123456789abcdefghij-_XYZ";
    const GEMINI: &str = "AIzaSyFICTIONALfictional0123456789abcdef";

    #[test]
    fn held_old_key_result_cannot_reject_or_verify_a_replacement() {
        use std::sync::mpsc;
        struct Held {
            entered: mpsc::Sender<()>,
            release: Mutex<mpsc::Receiver<()>>,
            answer: ProbeResult,
        }
        impl Probe for Held {
            fn check(&self, _: Provider, _: &Secret) -> ProbeResult {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                self.answer
            }
        }
        for answer in [ProbeResult::Rejected, ProbeResult::Accepted] {
            let (entered, started) = mpsc::channel();
            let (release, held) = mpsc::channel();
            let keys = Arc::new(Keys::new(
                Box::<MemoryStore>::default(),
                Box::new(Held {
                    entered,
                    release: Mutex::new(held),
                    answer,
                }),
            ));
            keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
            let worker_keys = keys.clone();
            let worker = std::thread::spawn(move || worker_keys.test(Provider::Anthropic));
            started
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            keys.set(Provider::Anthropic, &format!("{ANTHROPIC}replacement"))
                .unwrap();
            release.send(()).unwrap();
            let status = worker.join().unwrap().unwrap().anthropic;
            assert_eq!(status.state, KeyState::Set);
            assert!(
                !status.verified,
                "an old success cannot bless a replacement"
            );
        }
    }

    #[test]
    fn credential_results_are_owner_provider_and_mutation_scoped() {
        for (provider, text) in [
            (Provider::Anthropic, ANTHROPIC),
            (Provider::OpenAi, OPENAI),
            (Provider::Gemini, GEMINI),
            (Provider::Deepgram, DEEPGRAM),
            (Provider::ElevenLabs, ELEVENLABS),
        ] {
            for mutation in ["unchanged", "replace", "remove", "readd", "same", "other"] {
                for result in [ProbeResult::Rejected, ProbeResult::Accepted] {
                    let (keys, _, _) = keys(ProbeResult::Unreachable);
                    keys.set(provider, text).unwrap();
                    let (_, revision) = keys.get_with_revision(provider).unwrap();
                    match mutation {
                        "replace" => {
                            keys.set(provider, &format!("{text}replacement")).unwrap();
                        }
                        "remove" => {
                            keys.remove(provider).unwrap();
                        }
                        "readd" => {
                            keys.remove(provider).unwrap();
                            keys.set(provider, text).unwrap();
                        }
                        "same" => {
                            keys.set(provider, text).unwrap();
                        }
                        "other" => {
                            let (other, value) = if provider == Provider::Anthropic {
                                (Provider::OpenAi, OPENAI)
                            } else {
                                (Provider::Anthropic, ANTHROPIC)
                            };
                            keys.set(other, value).unwrap();
                        }
                        _ => {}
                    }
                    keys.apply_result(&revision, result);
                    let current = matches!(mutation, "unchanged" | "other");
                    let status = keys.status().of(provider);
                    assert_eq!(
                        status.state,
                        if mutation == "remove" {
                            KeyState::NotSet
                        } else if current && result == ProbeResult::Rejected {
                            KeyState::Rejected
                        } else {
                            KeyState::Set
                        }
                    );
                    assert_eq!(status.verified, current && result == ProbeResult::Accepted);
                    assert_eq!(
                        keys.memo()[provider.index()].rejected,
                        current && result == ProbeResult::Rejected
                    );
                    let (other_owner, _, _) = self::keys(ProbeResult::Unreachable);
                    other_owner.set(provider, text).unwrap();
                    other_owner.mark_rejected(&revision);
                    assert_eq!(other_owner.status().of(provider).state, KeyState::Set);
                }
            }
        }
    }

    #[test]
    fn serial_request_callback_retains_its_read_receipt_not_the_latest_key() {
        let keys = Box::leak(Box::new(Keys::new(
            Box::<MemoryStore>::default(),
            Box::new(NoNetwork),
        )));
        keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
        let mut old = keys.request_key(Provider::Anthropic);
        old.get().unwrap();
        keys.remove(Provider::Anthropic).unwrap();
        keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
        old.rejection_handler().mark_rejected();
        assert_eq!(keys.status().anthropic.state, KeyState::Set);
        let mut current = keys.request_key(Provider::Anthropic);
        current.get().unwrap();
        keys.set(Provider::OpenAi, OPENAI).unwrap();
        current.rejection_handler().mark_rejected();
        assert_eq!(keys.status().anthropic.state, KeyState::Rejected);
        assert_eq!(keys.status().openai.state, KeyState::Set);
    }

    #[test]
    fn failed_or_ambiguous_store_writes_retire_old_results_without_verifying_any_key() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Faulty {
            inner: MemoryStore,
            fail: Arc<AtomicBool>,
            write_before_error: bool,
        }
        impl SecretStore for Faulty {
            fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
                self.inner.get(account)
            }
            fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
                let fail = self.fail.load(Ordering::Acquire);
                if !fail || self.write_before_error {
                    self.inner.set(account, secret)?;
                }
                if fail {
                    Err(StoreError::Failed)
                } else {
                    Ok(())
                }
            }
            fn delete(&self, account: &str) -> Result<(), StoreError> {
                let fail = self.fail.load(Ordering::Acquire);
                if !fail || self.write_before_error {
                    self.inner.delete(account)?;
                }
                if fail {
                    Err(StoreError::Failed)
                } else {
                    Ok(())
                }
            }
        }
        for remove in [false, true] {
            for write_before_error in [false, true] {
                for answer in [ProbeResult::Accepted, ProbeResult::Rejected] {
                    let fail = Arc::new(AtomicBool::new(false));
                    let keys = Keys::new(
                        Box::new(Faulty {
                            inner: MemoryStore::default(),
                            fail: fail.clone(),
                            write_before_error,
                        }),
                        Box::new(NoNetwork),
                    );
                    keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
                    let (_, old) = keys.get_with_revision(Provider::Anthropic).unwrap();
                    keys.apply_result(&old, ProbeResult::Accepted);
                    assert!(keys.status().anthropic.verified);
                    fail.store(true, Ordering::Release);
                    let result = if remove {
                        keys.remove(Provider::Anthropic)
                    } else {
                        keys.set(Provider::Anthropic, &format!("{ANTHROPIC}replacement"))
                    };
                    assert!(matches!(result, Err(KeyError::Store)));
                    fail.store(false, Ordering::Release);
                    keys.apply_result(&old, answer);
                    let status = keys.status().anthropic;
                    assert!(
                        !status.verified,
                        "failed mutation cannot preserve or grant verification"
                    );
                    assert_eq!(
                        status.state,
                        if remove && write_before_error {
                            KeyState::NotSet
                        } else {
                            KeyState::Set
                        }
                    );
                    if !(remove && write_before_error) {
                        // An actual fresh read may still reject the credential
                        // that remained (or was written despite the error).
                        let (_, fresh) = keys.get_with_revision(Provider::Anthropic).unwrap();
                        keys.mark_rejected(&fresh);
                        assert_eq!(keys.status().anthropic.state, KeyState::Rejected);
                    }
                }
            }
        }
    }

    /// A store that records every call, so a test can see what was written.
    #[derive(Clone, Default)]
    struct Recording {
        inner: Arc<MemoryStore>,
        writes: Arc<Mutex<Vec<String>>>,
        fail: Arc<Mutex<bool>>,
    }

    impl SecretStore for Recording {
        fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
            if *self.fail.lock().unwrap() {
                return Err(StoreError::Failed);
            }
            self.inner.get(account)
        }
        fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
            if *self.fail.lock().unwrap() {
                return Err(StoreError::Failed);
            }
            self.writes.lock().unwrap().push(format!("set {account}"));
            self.inner.set(account, secret)
        }
        fn delete(&self, account: &str) -> Result<(), StoreError> {
            if *self.fail.lock().unwrap() {
                return Err(StoreError::Failed);
            }
            self.writes
                .lock()
                .unwrap()
                .push(format!("delete {account}"));
            self.inner.delete(account)
        }
    }

    #[derive(Clone)]
    struct Scripted(Arc<Mutex<Vec<(Provider, String)>>>, ProbeResult);

    impl Probe for Scripted {
        fn check(&self, provider: Provider, key: &Secret) -> ProbeResult {
            self.0
                .lock()
                .unwrap()
                .push((provider, key.expose().to_string()));
            self.1
        }
    }

    fn keys(answer: ProbeResult) -> (Keys, Recording, Scripted) {
        let store = Recording::default();
        let probe = Scripted(Arc::default(), answer);
        (
            Keys::new(Box::new(store.clone()), Box::new(probe.clone())),
            store,
            probe,
        )
    }

    fn not_set() -> KeyStatus {
        KeyStatus {
            state: KeyState::NotSet,
            verified: false,
        }
    }

    #[test]
    fn a_new_install_has_no_keys_and_says_so() {
        let (keys, _, probe) = keys(ProbeResult::Accepted);
        assert_eq!(
            keys.status(),
            KeysStatus {
                deepgram: not_set(),
                elevenlabs: not_set(),
                anthropic: not_set(),
                openai: not_set(),
                gemini: not_set(),
                any_missing: true,
                store: StoreStatus {
                    kind: StoreKind::Memory,
                    available: true,
                },
            }
        );
        assert_eq!(
            serde_json::to_value(keys.status()).unwrap(),
            serde_json::json!({
                "deepgram": {"state": "notSet", "verified": false},
                "elevenlabs": {"state": "notSet", "verified": false},
                "anthropic": {"state": "notSet", "verified": false},
                "openai": {"state": "notSet", "verified": false},
                "gemini": {"state": "notSet", "verified": false},
                "anyMissing": true,
                "store": {"kind": "memory", "available": true},
            })
        );
        assert!(probe.0.lock().unwrap().is_empty());
    }

    /// A system with no secret store (Linux without a keyring service): both
    /// keys read as unreadable rather than missing, so first-run setup does
    /// not ask for keys it cannot keep; saving one is refused with a message
    /// that says why; nothing is kept anywhere else.
    #[test]
    fn without_a_store_keys_cannot_be_saved_and_the_status_says_so() {
        struct NoStore;
        impl SecretStore for NoStore {
            fn kind(&self) -> StoreKind {
                StoreKind::SecretService
            }
            fn get(&self, _: &str) -> Result<Option<Secret>, StoreError> {
                Err(StoreError::Unavailable)
            }
            fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
                Err(StoreError::Unavailable)
            }
            fn delete(&self, _: &str) -> Result<(), StoreError> {
                Err(StoreError::Unavailable)
            }
        }
        let probe = Scripted(Arc::default(), ProbeResult::Accepted);
        let keys = Keys::new(Box::new(NoStore), Box::new(probe.clone()));
        let status = keys.status();
        assert_eq!(status.deepgram.state, KeyState::Unreadable);
        assert_eq!(status.elevenlabs.state, KeyState::Unreadable);
        assert_eq!(status.anthropic.state, KeyState::Unreadable);
        assert!(!status.any_missing);
        assert_eq!(
            status.store,
            StoreStatus {
                kind: StoreKind::SecretService,
                available: false,
            }
        );
        let refused = keys.set(Provider::Deepgram, DEEPGRAM).unwrap_err();
        assert_eq!(refused, KeyError::NoStore);
        assert_eq!(
            refused.message(),
            "This system has no keyring TalkQTE can use, so keys cannot be saved here yet. Nothing was changed."
        );
        assert_eq!(keys.test(Provider::Deepgram), Err(KeyError::NoStore));
        assert_eq!(keys.get(Provider::Anthropic).err(), Some(KeyError::NoStore));
        assert!(probe.0.lock().unwrap().is_empty());
    }

    /// A store that failed (locked or refused) is not the same as no store.
    #[test]
    fn a_failing_store_is_still_available() {
        let (keys, store, _) = keys(ProbeResult::Accepted);
        *store.fail.lock().unwrap() = true;
        let status = keys.status();
        assert_eq!(status.deepgram.state, KeyState::Unreadable);
        assert!(status.store.available);
        assert_eq!(
            keys.set(Provider::Deepgram, DEEPGRAM).unwrap_err(),
            KeyError::Store
        );
    }

    #[test]
    fn entering_a_key_stores_it_without_contacting_the_provider() {
        let (keys, store, probe) = keys(ProbeResult::Accepted);
        let status = keys
            .set(Provider::Anthropic, &format!("  {ANTHROPIC}\n"))
            .unwrap();
        assert_eq!(status.anthropic.state, KeyState::Set);
        assert!(!status.anthropic.verified);
        assert_eq!(status.deepgram.state, KeyState::NotSet);
        assert!(status.any_missing);
        // Trimmed before it was stored, under the Anthropic account only.
        assert_eq!(*store.writes.lock().unwrap(), ["set anthropic"]);
        assert_eq!(
            store.inner.get("anthropic").unwrap().unwrap().expose(),
            ANTHROPIC
        );
        assert!(probe.0.lock().unwrap().is_empty());

        let status = keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        assert!(!status.any_missing);
        // The serialized status carries no key text.
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains(ANTHROPIC) && !json.contains(DEEPGRAM));
    }

    #[test]
    fn a_key_of_the_wrong_shape_is_refused_before_anything_is_stored() {
        let (keys, store, _) = keys(ProbeResult::Accepted);
        for (provider, text) in [
            (Provider::Anthropic, ""),
            (
                Provider::Anthropic,
                "sk-ant-admin01-FICTIONALfictional0123456789abcdefghij",
            ),
            (
                Provider::Anthropic,
                "sk-ant-oat01-FICTIONALfictional0123456789abcdefghijkl",
            ),
            (Provider::Anthropic, "sk-ant-api03-short"),
            (
                Provider::Anthropic,
                "sk-ant-api03-FICTIONAL fictional0123456789abcdefghij",
            ),
            (Provider::Anthropic, DEEPGRAM),
            (Provider::Deepgram, ANTHROPIC),
            (Provider::Deepgram, "0123456789abcdef"),
            (
                Provider::Deepgram,
                "0123456789abcdef0123456789abcdef0123456\u{e9}",
            ),
            (
                Provider::Deepgram,
                "Token 0123456789abcdef0123456789abcdef01234567",
            ),
            (Provider::ElevenLabs, ""),
            (Provider::ElevenLabs, ANTHROPIC),
            (Provider::ElevenLabs, "sk_short"),
            (
                Provider::ElevenLabs,
                "sk_fictional 0123456789abcdef0123456789abcdef",
            ),
            (
                Provider::ElevenLabs,
                "not a valid elevenlabs key in prose here",
            ),
            (
                Provider::ElevenLabs,
                "xi-api-key sk_fictional0123456789abcdef0123456789",
            ),
            (
                Provider::ElevenLabs,
                "fictionaldeepgramkey0123456789abcdef0123",
            ),
        ] {
            let error = keys.set(provider, text).unwrap_err();
            assert_eq!(error, KeyError::Shape(provider));
            // The refusal never quotes what was pasted.
            assert!(text.is_empty() || !error.message().contains(text));
        }
        assert!(store.writes.lock().unwrap().is_empty());
        assert!(validate(
            Provider::Anthropic,
            "sk-ant-usr-FICTIONALfictional0123456789abcdefghijk"
        )
        .is_ok());
        assert!(validate(Provider::ElevenLabs, &format!("  {ELEVENLABS}\n")).is_ok());
        assert!(validate(Provider::ElevenLabs, ELEVENLABS_HEX).is_ok());
    }

    #[test]
    fn elevenlabs_keys_store_probe_and_clear_independently_of_deepgram() {
        let (keys, store, probe) = keys(ProbeResult::Accepted);
        keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
        let status = keys
            .set(Provider::ElevenLabs, &format!("  {ELEVENLABS}  "))
            .unwrap();
        assert_eq!(status.elevenlabs.state, KeyState::Set);
        assert!(!status.elevenlabs.verified);
        assert_eq!(status.deepgram.state, KeyState::NotSet);
        // Either Deepgram or ElevenLabs with Anthropic satisfies any_missing.
        assert!(!status.any_missing);
        assert_eq!(
            store.inner.get("elevenlabs").unwrap().unwrap().expose(),
            ELEVENLABS
        );
        let checked = keys.test(Provider::ElevenLabs).unwrap();
        assert_eq!(
            checked.elevenlabs,
            KeyStatus {
                state: KeyState::Set,
                verified: true
            }
        );
        assert_eq!(
            *probe.0.lock().unwrap(),
            [(Provider::ElevenLabs, ELEVENLABS.to_string())]
        );
        keys.mark_rejected(&keys.get_with_revision(Provider::ElevenLabs).unwrap().1);
        assert_eq!(keys.status().elevenlabs.state, KeyState::Rejected);
        let removed = keys.remove(Provider::ElevenLabs).unwrap();
        assert_eq!(removed.elevenlabs, not_set());
        assert!(removed.any_missing);
    }

    #[test]
    fn checking_a_key_sends_it_to_its_own_provider_once() {
        let (keys, _, probe) = keys(ProbeResult::Accepted);
        assert_eq!(
            keys.test(Provider::Deepgram).unwrap_err(),
            KeyError::NotSet(Provider::Deepgram)
        );
        keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
        let status = keys.test(Provider::Deepgram).unwrap();
        assert_eq!(
            status.deepgram,
            KeyStatus {
                state: KeyState::Set,
                verified: true
            }
        );
        assert!(!status.anthropic.verified);
        assert_eq!(
            *probe.0.lock().unwrap(),
            [(Provider::Deepgram, DEEPGRAM.to_string())]
        );
    }

    #[test]
    fn a_refused_key_shows_as_rejected_until_it_is_replaced_or_removed() {
        let (keys, _, _) = keys(ProbeResult::Rejected);
        keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
        let status = keys.test(Provider::Anthropic).unwrap();
        assert_eq!(status.anthropic.state, KeyState::Rejected);
        assert!(!status.anthropic.verified);
        // Still stored, so still not missing: the person replaces it.
        assert!(status.any_missing); // Deepgram is not set.
        keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        // A session refusal also marks it.
        keys.mark_rejected(&keys.get_with_revision(Provider::Deepgram).unwrap().1);
        assert_eq!(keys.status().deepgram.state, KeyState::Rejected);
        // Replacing clears it; removing clears it.
        let status = keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        assert_eq!(status.deepgram.state, KeyState::Set);
        let status = keys.remove(Provider::Anthropic).unwrap();
        assert_eq!(status.anthropic, not_set());
        assert!(status.any_missing);
    }

    #[test]
    fn an_unreachable_provider_changes_nothing() {
        let (keys, _, _) = keys(ProbeResult::Unreachable);
        keys.set(Provider::Anthropic, ANTHROPIC).unwrap();
        let before = keys.status();
        assert_eq!(
            keys.test(Provider::Anthropic).unwrap_err(),
            KeyError::Unreachable(Provider::Anthropic)
        );
        assert_eq!(keys.status(), before);
    }

    #[test]
    fn removing_a_key_deletes_it_from_the_store() {
        let (keys, store, _) = keys(ProbeResult::Accepted);
        keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        keys.remove(Provider::Deepgram).unwrap();
        assert!(store.inner.get("deepgram").unwrap().is_none());
        assert_eq!(
            keys.get(Provider::Deepgram).unwrap_err(),
            KeyError::NotSet(Provider::Deepgram)
        );
        // Removing a key that is not there is not an error.
        assert!(keys.remove(Provider::Deepgram).is_ok());
    }

    #[test]
    fn a_key_stored_by_an_earlier_run_is_found_at_launch() {
        let store = Recording::default();
        store
            .inner
            .set("anthropic", &Secret::for_test(ANTHROPIC))
            .unwrap();
        let keys = Keys::new(
            Box::new(store),
            Box::new(Scripted(Arc::default(), ProbeResult::Accepted)),
        );
        assert_eq!(keys.status().anthropic.state, KeyState::Set);
        assert_eq!(keys.get(Provider::Anthropic).unwrap().expose(), ANTHROPIC);
    }

    #[test]
    fn a_keychain_failure_is_reported_without_detail_and_nothing_is_assumed() {
        let (keys, store, _) = keys(ProbeResult::Accepted);
        *store.fail.lock().unwrap() = true;
        assert_eq!(
            keys.set(Provider::Anthropic, ANTHROPIC).unwrap_err(),
            KeyError::Store
        );
        // Not reported as missing: the Keychain could not be read.
        assert_eq!(keys.status().anthropic.state, KeyState::Unreadable);
        assert!(!keys.status().any_missing || keys.status().deepgram.state != KeyState::NotSet);
        assert_eq!(keys.get(Provider::Anthropic).unwrap_err(), KeyError::Store);
        *store.fail.lock().unwrap() = false;
        assert_eq!(keys.status().anthropic.state, KeyState::NotSet);
        #[cfg(target_os = "macos")]
        assert_eq!(
            KeyError::Store.message(),
            "The Keychain could not be used. Nothing was changed."
        );
        #[cfg(windows)]
        assert_eq!(
            KeyError::Store.message(),
            "Windows Credential Manager could not be used. Nothing was changed."
        );
        #[cfg(target_os = "linux")]
        assert_eq!(
            KeyError::Store.message(),
            "The keyring could not be used. Unlock it or allow access, then try again. Nothing was changed."
        );
    }

    #[test]
    fn a_key_deleted_outside_the_app_is_seen_at_the_next_status() {
        let (keys, store, _) = keys(ProbeResult::Accepted);
        keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        assert_eq!(keys.status().deepgram.state, KeyState::Set);
        store.inner.delete("deepgram").unwrap();
        assert_eq!(keys.status().deepgram.state, KeyState::NotSet);
        store
            .inner
            .set("deepgram", &Secret::for_test(DEEPGRAM))
            .unwrap();
        assert_eq!(keys.status().deepgram.state, KeyState::Set);
    }

    #[test]
    fn a_key_never_appears_in_debug_output() {
        let secret = validate(Provider::Anthropic, ANTHROPIC).unwrap();
        assert_eq!(format!("{secret:?}"), "Secret(redacted)");
        assert!(!format!("{:?}", Ok::<_, KeyError>(secret)).contains("sk-ant"));
    }

    #[test]
    fn the_test_build_never_uses_the_real_keychain_or_network() {
        // The shared store starts empty in every test run and is never
        // written by tests, so parallel tests cannot see each other's keys.
        let keys = global();
        assert!(keys.status().any_missing);
        assert_eq!(
            keys.test(Provider::Deepgram).unwrap_err(),
            KeyError::NotSet(Provider::Deepgram)
        );
        assert_eq!(
            NoNetwork.check(Provider::Deepgram, &Secret::for_test(DEEPGRAM)),
            ProbeResult::Unreachable
        );
    }

    #[test]
    fn openai_and_gemini_keys_are_validated_stored_and_tested_like_anthropic() {
        let (keys, store, probe) = keys(ProbeResult::Accepted);
        for (provider, bad) in [
            (Provider::OpenAi, ""),
            (Provider::OpenAi, "sk-short"),
            (Provider::OpenAi, ANTHROPIC),
            (Provider::OpenAi, "sk-proj-with space 0123456789abcdef"),
            (Provider::OpenAi, GEMINI),
            (Provider::Gemini, ""),
            (Provider::Gemini, "AIzaShort"),
            (Provider::Gemini, "AIzaWithSpace 0123456789abcdefghijklm"),
            (Provider::Gemini, OPENAI),
            (Provider::Gemini, DEEPGRAM),
        ] {
            let err = keys.set(provider, bad).unwrap_err();
            assert_eq!(err, KeyError::Shape(provider), "{provider:?}");
            assert!(bad.is_empty() || !err.message().contains(bad));
        }
        assert!(store.writes.lock().unwrap().is_empty());

        keys.set(Provider::OpenAi, &format!("  {OPENAI}\n"))
            .unwrap();
        keys.set(Provider::Gemini, &format!("  {GEMINI}\n"))
            .unwrap();
        assert_eq!(store.inner.get("openai").unwrap().unwrap().expose(), OPENAI);
        assert_eq!(store.inner.get("gemini").unwrap().unwrap().expose(), GEMINI);
        // Deepgram is still missing, so any_missing stays true.
        assert!(keys.status().any_missing);
        keys.set(Provider::Deepgram, DEEPGRAM).unwrap();
        // With Deepgram and OpenAI/Gemini set (and Anthropic still unset), nothing is missing.
        assert!(!keys.status().any_missing);

        let status = keys.test(Provider::OpenAi).unwrap();
        assert_eq!(
            status.openai,
            KeyStatus {
                state: KeyState::Set,
                verified: true,
            }
        );
        let status = keys.test(Provider::Gemini).unwrap();
        assert_eq!(
            status.gemini,
            KeyStatus {
                state: KeyState::Set,
                verified: true,
            }
        );
        assert_eq!(
            *probe.0.lock().unwrap(),
            [
                (Provider::OpenAi, OPENAI.to_string()),
                (Provider::Gemini, GEMINI.to_string()),
            ]
        );

        keys.mark_rejected(&keys.get_with_revision(Provider::OpenAi).unwrap().1);
        assert_eq!(keys.status().openai.state, KeyState::Rejected);
        keys.remove(Provider::OpenAi).unwrap();
        assert_eq!(keys.status().openai, not_set());
        keys.remove(Provider::Gemini).unwrap();
        assert_eq!(keys.status().gemini, not_set());
        assert!(keys.status().any_missing);
    }
}
