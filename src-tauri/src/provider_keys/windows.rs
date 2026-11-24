//! Provider keys in Windows Credential Manager: one generic credential per
//! key, persisted for this user on this computer only (not the roaming
//! "enterprise" persistence, so a key does not follow a domain profile to
//! other machines). The key is the credential's blob; its target name is
//! `<service>/<account>`, so it can be found and removed in Control Panel →
//! Credential Manager → Windows Credentials.

use super::{Secret, SecretStore, StoreError, StoreKind};
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use zeroize::Zeroizing;

/// `ERROR_NOT_FOUND` from winerror.h: no credential has that target name.
const ERROR_NOT_FOUND: i32 = 1168;
/// `ERROR_NO_SUCH_LOGON_SESSION`: the process has no logon session with a
/// credential set (a service account without a loaded profile).
const ERROR_NO_SUCH_LOGON_SESSION: i32 = 1312;

pub struct CredentialManager {
    service: &'static str,
}

impl CredentialManager {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn target(&self, account: &str) -> Vec<u16> {
        wide(&format!("{}/{account}", self.service))
    }
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain([0]).collect()
}

fn last_error() -> StoreError {
    match std::io::Error::last_os_error().raw_os_error() {
        Some(ERROR_NO_SUCH_LOGON_SESSION) => StoreError::Unavailable,
        _ => StoreError::Failed,
    }
}

impl SecretStore for CredentialManager {
    fn kind(&self) -> StoreKind {
        StoreKind::CredentialManager
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        let target = self.target(account);
        let mut credential: *mut CREDENTIALW = ptr::null_mut();
        // SAFETY: `target` is a NUL-terminated UTF-16 string that outlives the
        // call; on success CredReadW hands back one allocation, freed below.
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            return match std::io::Error::last_os_error().raw_os_error() {
                Some(ERROR_NOT_FOUND) => Ok(None),
                _ => Err(last_error()),
            };
        }
        // SAFETY: CredReadW succeeded, so `credential` points to a valid
        // CREDENTIALW whose blob is `CredentialBlobSize` bytes long. The bytes
        // are copied into a zeroizing buffer before the allocation is freed.
        let bytes = unsafe {
            let credential = &*credential;
            let blob = if credential.CredentialBlob.is_null() {
                &[][..]
            } else {
                std::slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                )
            };
            Zeroizing::new(blob.to_vec())
        };
        // SAFETY: the single allocation returned by CredReadW.
        unsafe { CredFree(credential.cast()) };
        let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::Failed)?;
        Ok(Some(Secret(Zeroizing::new(text.to_string()))))
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        let mut target = self.target(account);
        let mut user = wide(account);
        let mut blob = Zeroizing::new(secret.expose().as_bytes().to_vec());
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: u32::try_from(blob.len()).map_err(|_| StoreError::Failed)?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: user.as_mut_ptr(),
            ..Default::default()
        };
        // SAFETY: every pointer in `credential` refers to a buffer above that
        // lives until after the call; CredWriteW copies what it keeps.
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(last_error());
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        let target = self.target(account);
        // SAFETY: a NUL-terminated UTF-16 target name that outlives the call.
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            return match std::io::Error::last_os_error().raw_os_error() {
                Some(ERROR_NOT_FOUND) => Ok(()),
                _ => Err(last_error()),
            };
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes, reads and removes one fictional key in this runner's real
    /// Credential Manager, under a test-only service name, so no TalkQTE key
    /// is touched. Ignored by default; CI runs it on Windows with
    /// `cargo test -- --ignored real_credential_manager`.
    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_round_trip() {
        let store = CredentialManager::new("app.talkqte.provider-key.ci-test");
        let account = "fictional";
        store.delete(account).unwrap();
        assert!(store.get(account).unwrap().is_none());
        store
            .set(account, &Secret::for_test("fictional-0123456789abcdef"))
            .unwrap();
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
        store.delete(account).unwrap();
    }
}
