//! The notebook's commands for the person's own provider keys. A key crosses
//! from the webview to Rust once, when it is entered; every reply carries
//! only the keys' states. Keychain access and the provider check run off the
//! main thread, because the Keychain may ask the person to allow access.

use crate::provider_keys::{self, KeysStatus, Provider};
use tauri::Emitter;
use zeroize::Zeroizing;

/// The event the main window receives after any key change.
pub const CHANGED: &str = "provider-keys:changed";

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, provider_keys::KeyError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| provider_keys::KeyError::Store.message().to_string())?
        .map_err(String::from)
}

fn changed(app: &tauri::AppHandle, status: KeysStatus) -> KeysStatus {
    let _ = app.emit_to("main", CHANGED, status);
    status
}

/// Whether each key is set, set and checked, or rejected. Read at launch to
/// decide whether to ask for keys.
#[tauri::command]
pub async fn provider_keys_status() -> Result<KeysStatus, String> {
    blocking(|| Ok(provider_keys::global().status())).await
}

/// Stores a key, or replaces the stored one, after a shape check. Nothing is
/// sent to the provider.
#[tauri::command]
pub async fn set_provider_key(
    app: tauri::AppHandle,
    provider: Provider,
    key: String,
) -> Result<KeysStatus, String> {
    let key = Zeroizing::new(key);
    let status = blocking(move || provider_keys::global().set(provider, &key)).await?;
    Ok(changed(&app, status))
}

/// Checks the stored key with one read-only request to its provider.
#[tauri::command]
pub async fn test_provider_key(
    app: tauri::AppHandle,
    provider: Provider,
) -> Result<KeysStatus, String> {
    let status = blocking(move || provider_keys::global().test(provider)).await?;
    Ok(changed(&app, status))
}

/// Deletes the stored key from the Keychain.
#[tauri::command]
pub async fn remove_provider_key(
    app: tauri::AppHandle,
    provider: Provider,
) -> Result<KeysStatus, String> {
    let status = blocking(move || provider_keys::global().remove(provider)).await?;
    Ok(changed(&app, status))
}

/// This session's requests and estimated spend with the person's Anthropic
/// key, or null before a session has used it. Content-free.
#[tauri::command]
pub fn cue_usage() -> Option<crate::anthropic_api::UsageSnapshot> {
    crate::anthropic_api::usage()
}
