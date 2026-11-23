//! The person's own provider keys: one Deepgram key for transcription and one
//! Anthropic API key for cue decisions.
//!
//! Keys live only in the macOS Keychain, as generic passwords under the
//! service [`SERVICE`]. They are never written to a file, never logged, never
//! put in an error and never sent back to the webview: the notebook receives
//! only whether each key is set, set and checked, or rejected. A key's shape
//! is checked before it is stored. Checking a key is an explicit action that
//! makes one read-only request to its provider; storing one sends nothing.
//!
//! Tests use [`MemoryStore`] and a scripted [`Probe`]; none of them reaches the
//! Keychain or the network.

use serde::{Deserialize, Serialize};
use std::{fmt, sync::Mutex, time::Duration};
use zeroize::Zeroizing;

/// The Keychain service every TalkQTE provider key is stored under.
pub const SERVICE: &str = "app.talkqte.provider-key";

/// The two providers a key can be entered for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Deepgram,
    Anthropic,
}

impl Provider {
    pub const ALL: [Self; 2] = [Self::Deepgram, Self::Anthropic];

    /// The Keychain account name for this provider's key.
    pub fn account(self) -> &'static str {
        match self {
            Self::Deepgram => "deepgram",
            Self::Anthropic => "anthropic",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Deepgram => "Deepgram",
            Self::Anthropic => "Anthropic",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Deepgram => 0,
            Self::Anthropic => 1,
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
            Self::Store => "The Keychain could not be used. Nothing was changed.",
            Self::NotSet(Provider::Anthropic) => "No Anthropic key is set.",
            Self::NotSet(Provider::Deepgram) => "No Deepgram key is set.",
            Self::Unreachable(Provider::Anthropic) => {
                "Anthropic could not be reached to check the key. Nothing was changed."
            }
            Self::Unreachable(Provider::Deepgram) => {
                "Deepgram could not be reached to check the key. Nothing was changed."
            }
        }
    }
}

impl From<KeyError> for String {
    fn from(error: KeyError) -> Self {
        error.message().to_string()
    }
}

/// A store that could not be used. It carries no detail by design.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreError;

/// Where keys are kept. The app uses the Keychain; tests use memory.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError>;
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError>;
    fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// The login Keychain, through Security.framework's generic passwords.
#[cfg(target_os = "macos")]
pub struct Keychain;

#[cfg(target_os = "macos")]
impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(SERVICE, account) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let text = std::str::from_utf8(&bytes).map_err(|_| StoreError)?;
                Ok(Some(Secret(Zeroizing::new(text.to_string()))))
            }
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err(StoreError),
        }
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        security_framework::passwords::set_generic_password(
            SERVICE,
            account,
            secret.expose().as_bytes(),
        )
        .map_err(|_| StoreError)
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        match security_framework::passwords::delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err(StoreError),
        }
    }
}

/// `errSecItemNotFound` from Security.framework's SecBase.h.
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Keys held in memory only: tests, and platforms without a Keychain, where
/// nothing is kept past quit.
#[derive(Default)]
pub struct MemoryStore(Mutex<Vec<(String, Secret)>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        let items = self.0.lock().map_err(|_| StoreError)?;
        Ok(items
            .iter()
            .find(|(name, _)| name == account)
            .map(|(_, secret)| secret.clone()))
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        let mut items = self.0.lock().map_err(|_| StoreError)?;
        items.retain(|(name, _)| name != account);
        items.push((account.to_string(), secret.clone()));
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.0
            .lock()
            .map_err(|_| StoreError)?
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub state: KeyState,
    /// The provider accepted the key at the last check in this app run.
    pub verified: bool,
}

/// Both keys' states, the whole payload the notebook receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysStatus {
    pub deepgram: KeyStatus,
    pub anthropic: KeyStatus,
    /// At least one key is not set: what a first-run screen asks for.
    pub any_missing: bool,
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
}

/// The key store plus what this app run has learned about each key.
pub struct Keys {
    store: Box<dyn SecretStore>,
    probe: Box<dyn Probe>,
    memo: Mutex<[Memo; 2]>,
}

impl Keys {
    pub fn new(store: Box<dyn SecretStore>, probe: Box<dyn Probe>) -> Self {
        Self {
            store,
            probe,
            memo: Mutex::new([Memo::default(); 2]),
        }
    }

    fn memo(&self) -> std::sync::MutexGuard<'_, [Memo; 2]> {
        self.memo
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn present(&self, provider: Provider) -> Result<bool, KeyError> {
        if let Some(present) = self.memo()[provider.index()].present {
            return Ok(present);
        }
        let present = self
            .store
            .get(provider.account())
            .map_err(|_| KeyError::Store)?
            .is_some();
        self.memo()[provider.index()].present = Some(present);
        Ok(present)
    }

    fn key_status(&self, provider: Provider) -> KeyStatus {
        // A Keychain that cannot be read reports the key as not set, so
        // nothing is attempted with it; saving again reports the failure.
        let present = self.present(provider).unwrap_or(false);
        let memo = self.memo()[provider.index()];
        KeyStatus {
            state: match (present, memo.rejected) {
                (false, _) => KeyState::NotSet,
                (true, true) => KeyState::Rejected,
                (true, false) => KeyState::Set,
            },
            verified: present && memo.verified && !memo.rejected,
        }
    }

    pub fn status(&self) -> KeysStatus {
        let deepgram = self.key_status(Provider::Deepgram);
        let anthropic = self.key_status(Provider::Anthropic);
        KeysStatus {
            deepgram,
            anthropic,
            any_missing: deepgram.state == KeyState::NotSet || anthropic.state == KeyState::NotSet,
        }
    }

    /// Stores a new key or replaces the old one, after the shape check. It is
    /// not checked with the provider until the person asks.
    pub fn set(&self, provider: Provider, text: &str) -> Result<KeysStatus, KeyError> {
        let secret = validate(provider, text)?;
        self.store
            .set(provider.account(), &secret)
            .map_err(|_| KeyError::Store)?;
        self.memo()[provider.index()] = Memo {
            present: Some(true),
            rejected: false,
            verified: false,
        };
        Ok(self.status())
    }

    pub fn remove(&self, provider: Provider) -> Result<KeysStatus, KeyError> {
        self.store
            .delete(provider.account())
            .map_err(|_| KeyError::Store)?;
        self.memo()[provider.index()] = Memo {
            present: Some(false),
            rejected: false,
            verified: false,
        };
        Ok(self.status())
    }

    /// The stored key, for the one request that uses it. Never returned to
    /// the webview.
    pub fn get(&self, provider: Provider) -> Result<Secret, KeyError> {
        let secret = self
            .store
            .get(provider.account())
            .map_err(|_| KeyError::Store)?;
        self.memo()[provider.index()].present = Some(secret.is_some());
        secret.ok_or(KeyError::NotSet(provider))
    }

    pub fn is_set(&self, provider: Provider) -> bool {
        self.present(provider).unwrap_or(false)
    }

    /// Asks the provider whether the stored key works, with one read-only
    /// request. An unreachable provider changes nothing.
    pub fn test(&self, provider: Provider) -> Result<KeysStatus, KeyError> {
        let secret = self.get(provider)?;
        let result = self.probe.check(provider, &secret);
        drop(secret);
        match result {
            ProbeResult::Accepted => {
                let mut memo = self.memo();
                memo[provider.index()].rejected = false;
                memo[provider.index()].verified = true;
            }
            ProbeResult::Rejected => self.mark_rejected(provider),
            ProbeResult::Unreachable => return Err(KeyError::Unreachable(provider)),
        }
        Ok(self.status())
    }

    /// The provider refused the key during a session (401 or 403).
    pub fn mark_rejected(&self, provider: Provider) {
        let mut memo = self.memo();
        memo[provider.index()].rejected = true;
        memo[provider.index()].verified = false;
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
                .header("Authorization", &format!("Token {}", key.expose()))
                .call(),
            Provider::Anthropic => agent
                .get("https://api.anthropic.com/v1/models?limit=1")
                .header("x-api-key", key.expose())
                .header("anthropic-version", ANTHROPIC_VERSION)
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

/// This app run's keys: the Keychain in the app, memory in tests, so no test
/// can read or change a real key.
pub fn global() -> &'static Keys {
    static KEYS: std::sync::OnceLock<Keys> = std::sync::OnceLock::new();
    KEYS.get_or_init(|| {
        #[cfg(all(target_os = "macos", not(test)))]
        let store: Box<dyn SecretStore> = Box::new(Keychain);
        #[cfg(not(all(target_os = "macos", not(test))))]
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
                return Err(StoreError);
            }
            self.inner.get(account)
        }
        fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
            if *self.fail.lock().unwrap() {
                return Err(StoreError);
            }
            self.writes.lock().unwrap().push(format!("set {account}"));
            self.inner.set(account, secret)
        }
        fn delete(&self, account: &str) -> Result<(), StoreError> {
            if *self.fail.lock().unwrap() {
                return Err(StoreError);
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
                anthropic: not_set(),
                any_missing: true,
            }
        );
        assert_eq!(
            serde_json::to_value(keys.status()).unwrap(),
            serde_json::json!({
                "deepgram": {"state": "notSet", "verified": false},
                "anthropic": {"state": "notSet", "verified": false},
                "anyMissing": true,
            })
        );
        assert!(probe.0.lock().unwrap().is_empty());
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
        assert!(!keys.status().any_missing);
        // A session refusal also marks it.
        keys.mark_rejected(Provider::Deepgram);
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
        assert_eq!(keys.status().anthropic, not_set());
        assert_eq!(keys.get(Provider::Anthropic).unwrap_err(), KeyError::Store);
        assert_eq!(
            KeyError::Store.message(),
            "The Keychain could not be used. Nothing was changed."
        );
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
}
