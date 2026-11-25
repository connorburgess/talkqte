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

/// The transcription provider for the next live session with the person's
/// own key: `"deepgram"` or `"elevenlabs"`.
#[tauri::command]
pub fn transcription_provider() -> crate::transcription::cloud::Provider {
    crate::transcription::cloud::provider()
}

/// Chooses the transcription provider for the next live session. Refused
/// while a live session is starting, running or finishing.
#[tauri::command]
pub fn set_transcription_provider(
    app: tauri::AppHandle,
    state: tauri::State<crate::AppState>,
    provider: crate::transcription::cloud::Provider,
) -> Result<crate::transcription::cloud::Provider, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let provider = set_provider_when_closed(runtime.live_session_open(), provider)?;
    crate::settings_commands::record(&app, |settings| {
        settings.transcription_provider = provider;
    });
    Ok(provider)
}

fn set_provider_when_closed(
    session_open: bool,
    provider: crate::transcription::cloud::Provider,
) -> Result<crate::transcription::cloud::Provider, String> {
    if session_open {
        return Err("Change the transcription provider when no live session is running.".into());
    }
    crate::transcription::cloud::set_provider(provider);
    Ok(crate::transcription::cloud::provider())
}

/// The transcription language for the next live session with the person's
/// own key: `"en"` (English) or `"multi"` (Multilingual).
#[tauri::command]
pub fn transcription_language() -> crate::transcription::cloud::Language {
    crate::transcription::cloud::language()
}

/// Chooses the transcription language for the next live session. Refused
/// while a live session is starting, running or finishing, so its streams
/// and its review always name the same language; nothing is sent by this.
#[tauri::command]
pub fn set_transcription_language(
    app: tauri::AppHandle,
    state: tauri::State<crate::AppState>,
    language: crate::transcription::cloud::Language,
) -> Result<crate::transcription::cloud::Language, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let language = set_language_when_closed(runtime.live_session_open(), language)?;
    crate::settings_commands::record(&app, |settings| {
        settings.transcription_language = language;
    });
    Ok(language)
}

fn set_language_when_closed(
    session_open: bool,
    language: crate::transcription::cloud::Language,
) -> Result<crate::transcription::cloud::Language, String> {
    if session_open {
        return Err("Change the transcription language when no live session is running.".into());
    }
    crate::transcription::cloud::set_language(language);
    Ok(crate::transcription::cloud::language())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::cloud::{language, provider, Language, Provider as SttProvider};

    #[test]
    fn the_provider_changes_only_between_sessions() {
        assert_eq!(
            set_provider_when_closed(true, SttProvider::ElevenLabs).unwrap_err(),
            "Change the transcription provider when no live session is running."
        );
        assert_eq!(provider(), SttProvider::Deepgram);
        assert_eq!(
            set_provider_when_closed(false, SttProvider::ElevenLabs),
            Ok(SttProvider::ElevenLabs)
        );
        assert_eq!(
            set_provider_when_closed(false, SttProvider::Deepgram),
            Ok(SttProvider::Deepgram)
        );
    }

    #[test]
    fn the_language_changes_only_between_sessions() {
        assert_eq!(
            set_language_when_closed(true, Language::Multilingual).unwrap_err(),
            "Change the transcription language when no live session is running."
        );
        assert_eq!(language(), Language::English);
        assert_eq!(
            set_language_when_closed(false, Language::Multilingual),
            Ok(Language::Multilingual)
        );
        assert_eq!(
            set_language_when_closed(false, Language::English),
            Ok(Language::English)
        );
    }
}
