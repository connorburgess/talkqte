//! Provider keys in the desktop's keyring through the freedesktop Secret
//! Service over the session D-Bus: GNOME Keyring on Ubuntu's desktop, or
//! KWallet and others that implement the same interface. Each key is one item
//! in the default collection with the attributes `service` and `account`, and
//! a label naming TalkQTE, so it appears in Passwords and Keys (Seahorse).
//!
//! Without a session bus or a Secret Service provider (a headless or minimal
//! system), the store reports itself unavailable: nothing is kept anywhere
//! else, and the notebook says keys cannot be saved on this system yet.
//!
//! Secrets cross the local session bus in the Secret Service's "plain"
//! transfer, which is the same user's bus and processes; the keyring itself
//! encrypts what it stores. The optional Diffie-Hellman transfer would add
//! several cryptography crates and protects only against a process that can
//! already read this user's session bus.

use super::{Secret, SecretStore, StoreError, StoreKind};
use dbus_secret_service::{EncryptionType, Error, SecretService as Service};
use std::{collections::HashMap, time::Duration};
use zeroize::Zeroizing;

/// How long to wait for the session bus to answer before calling the store
/// unavailable, so a stuck bus cannot hold the key commands forever.
const CONNECT: Duration = Duration::from_secs(3);

pub struct SecretService {
    service: &'static str,
}

impl SecretService {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn attributes<'a>(&'a self, account: &'a str) -> HashMap<&'a str, &'a str> {
        HashMap::from([("service", self.service), ("account", account)])
    }
}

fn connect() -> Result<Service, StoreError> {
    // Any failure to reach the bus or open a session with a provider means
    // there is no store to use.
    Service::connect_with_connection_timeout(EncryptionType::Plain, CONNECT)
        .map_err(|_| StoreError::Unavailable)
}

/// Whether a failure means "no keyring here" rather than "the keyring
/// failed": the provider went away, or no collection exists to keep keys in.
fn classify(error: Error) -> StoreError {
    match error {
        Error::Unavailable | Error::NoResult => StoreError::Unavailable,
        Error::Dbus(error)
            if error.name().is_some_and(|name| {
                matches!(
                    name,
                    "org.freedesktop.DBus.Error.ServiceUnknown"
                        | "org.freedesktop.DBus.Error.NameHasNoOwner"
                        | "org.freedesktop.DBus.Error.NoServer"
                        | "org.freedesktop.DBus.Error.Disconnected"
                ) || name.starts_with("org.freedesktop.DBus.Error.Spawn")
            }) =>
        {
            StoreError::Unavailable
        }
        _ => StoreError::Failed,
    }
}

impl SecretStore for SecretService {
    fn kind(&self) -> StoreKind {
        StoreKind::SecretService
    }

    /// Searching reads only the items' attributes, so it needs no unlock
    /// prompt: launch can show whether keys are set without asking.
    fn contains(&self, account: &str) -> Result<bool, StoreError> {
        let service = connect()?;
        let found = service
            .search_items(self.attributes(account))
            .map_err(classify)?;
        Ok(!(found.unlocked.is_empty() && found.locked.is_empty()))
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        let service = connect()?;
        let found = service
            .search_items(self.attributes(account))
            .map_err(classify)?;
        let Some(item) = found.unlocked.first().or(found.locked.first()) else {
            return Ok(None);
        };
        // May show the keyring's own unlock prompt; the key commands run off
        // the main thread for this reason, as they do for the Keychain.
        item.ensure_unlocked().map_err(classify)?;
        let bytes = Zeroizing::new(item.get_secret().map_err(classify)?);
        let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::Failed)?;
        Ok(Some(Secret(Zeroizing::new(text.to_string()))))
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        let service = connect()?;
        let collection = service.get_default_collection().map_err(classify)?;
        collection.ensure_unlocked().map_err(classify)?;
        collection
            .create_item(
                &format!("TalkQTE provider key ({account})"),
                self.attributes(account),
                secret.expose().as_bytes(),
                true,
                "text/plain",
            )
            .map(drop)
            .map_err(classify)
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        let service = connect()?;
        let found = service
            .search_items(self.attributes(account))
            .map_err(classify)?;
        for item in found.unlocked.iter().chain(&found.locked) {
            item.delete().map_err(classify)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SERVICE: &str = "app.talkqte.provider-key.ci-test";

    /// Writes, reads and removes one fictional key in a real Secret Service
    /// (CI starts a throwaway GNOME Keyring in its own session bus), under a
    /// test-only service name. Ignored by default.
    #[test]
    #[ignore = "needs a running Secret Service"]
    fn real_secret_service_round_trip() {
        let store = SecretService::new(TEST_SERVICE);
        let account = "fictional";
        store.delete(account).unwrap();
        assert_eq!(store.contains(account), Ok(false));
        assert!(store.get(account).unwrap().is_none());
        store
            .set(account, &Secret::for_test("fictional-0123456789abcdef"))
            .unwrap();
        assert_eq!(store.contains(account), Ok(true));
        assert_eq!(
            store.get(account).unwrap().unwrap().expose(),
            "fictional-0123456789abcdef"
        );
        store
            .set(account, &Secret::for_test("fictional-replacement"))
            .unwrap();
        assert_eq!(
            store.get(account).unwrap().unwrap().expose(),
            "fictional-replacement"
        );
        store.delete(account).unwrap();
        assert!(store.get(account).unwrap().is_none());
    }

    /// With a session bus but no Secret Service provider on it (CI runs this
    /// under a bare `dbus-run-session`), every operation reports the store
    /// unavailable rather than failing or keeping the key elsewhere.
    #[test]
    #[ignore = "needs a session bus without a Secret Service"]
    fn no_secret_service_is_unavailable() {
        let store = SecretService::new(TEST_SERVICE);
        assert_eq!(store.contains("fictional"), Err(StoreError::Unavailable));
        assert_eq!(store.get("fictional").err(), Some(StoreError::Unavailable));
        assert_eq!(
            store.set("fictional", &Secret::for_test("fictional-0123456789abcdef")),
            Err(StoreError::Unavailable)
        );
        assert_eq!(store.delete("fictional"), Err(StoreError::Unavailable));
    }
}
