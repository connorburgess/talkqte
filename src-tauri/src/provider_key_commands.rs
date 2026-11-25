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

/// This session's requests and estimated spend with the person's active cue
/// provider key, or null before a session has used it. Content-free.
#[tauri::command]
pub fn cue_usage() -> Option<crate::llm_provider::CueUsageSnapshot> {
    crate::llm_provider::cue_usage()
}

/// Active cue & notes provider and model selections.
#[tauri::command]
pub fn provider_preferences() -> crate::llm_provider::ProviderPreferences {
    crate::llm_provider::preferences().snapshot()
}

/// Chooses the provider (`"anthropic"`, `"openai"`, or `"gemini"`) for cue
/// decisions and meeting notes. Refused while a live session is open.
#[tauri::command]
pub fn set_cue_provider(
    app: tauri::AppHandle,
    state: tauri::State<crate::AppState>,
    provider: crate::llm_provider::CueProvider,
) -> Result<crate::llm_provider::ProviderPreferences, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let prefs = set_cue_provider_when_closed(runtime.live_session_open(), provider)?;
    crate::settings_commands::record(&app, |settings| {
        settings.cue_provider = prefs.cue_provider;
        settings.cue_model_override = prefs.cue_model_override.clone();
        settings.notes_model_override = prefs.notes_model_override.clone();
    });
    Ok(prefs)
}

fn set_cue_provider_when_closed(
    session_open: bool,
    provider: crate::llm_provider::CueProvider,
) -> Result<crate::llm_provider::ProviderPreferences, String> {
    if session_open {
        return Err("Change the cue provider when no live session is running.".into());
    }
    Ok(crate::llm_provider::set_cue_provider(provider))
}

/// Sets or clears (`""` / `None`) the custom cue model ID for the active provider.
/// Refused while a live session is open.
#[tauri::command]
pub fn set_cue_model_override(
    app: tauri::AppHandle,
    state: tauri::State<crate::AppState>,
    model: Option<String>,
) -> Result<crate::llm_provider::ProviderPreferences, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let prefs = set_cue_model_override_when_closed(runtime.live_session_open(), model.as_deref())?;
    crate::settings_commands::record(&app, |settings| {
        settings.cue_model_override = prefs.cue_model_override.clone();
    });
    Ok(prefs)
}

fn set_cue_model_override_when_closed(
    session_open: bool,
    model: Option<&str>,
) -> Result<crate::llm_provider::ProviderPreferences, String> {
    if session_open {
        return Err("Change the cue model when no live session is running.".into());
    }
    let validated = match model {
        Some(raw) => crate::llm_provider::validate_model_id(raw)?,
        None => None,
    };
    Ok(crate::llm_provider::set_cue_model_override(validated))
}

/// Sets or clears (`""` / `None`) the custom meeting-notes model ID for the active provider.
#[tauri::command]
pub fn set_notes_model_override(
    app: tauri::AppHandle,
    model: Option<String>,
) -> Result<crate::llm_provider::ProviderPreferences, String> {
    let validated = match model.as_deref() {
        Some(raw) => crate::llm_provider::validate_model_id(raw)?,
        None => None,
    };
    let prefs = crate::llm_provider::set_notes_model_override(validated);
    crate::settings_commands::record(&app, |settings| {
        settings.notes_model_override = prefs.notes_model_override.clone();
    });
    Ok(prefs)
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

    #[test]
    fn cue_provider_and_model_override_change_only_between_sessions() {
        use crate::llm_provider::CueProvider;
        assert_eq!(
            set_cue_provider_when_closed(true, CueProvider::OpenAi).unwrap_err(),
            "Change the cue provider when no live session is running."
        );
        assert_eq!(
            set_cue_model_override_when_closed(true, Some("gpt-5")).unwrap_err(),
            "Change the cue model when no live session is running."
        );
        let prefs = set_cue_provider_when_closed(false, CueProvider::OpenAi).unwrap();
        assert_eq!(prefs.cue_provider, CueProvider::OpenAi);
        assert_eq!(prefs.effective_cue_model, "gpt-5-mini");
        assert!(!prefs.effective_cue_custom);

        let prefs = set_cue_model_override_when_closed(false, Some("gpt-5.4-codex")).unwrap();
        assert_eq!(prefs.effective_cue_model, "gpt-5.4-codex");
        assert!(prefs.effective_cue_custom);

        assert!(set_cue_model_override_when_closed(false, Some("bad model!")).is_err());

        let prefs = set_cue_provider_when_closed(false, CueProvider::Anthropic).unwrap();
        assert_eq!(prefs.cue_provider, CueProvider::Anthropic);
        assert_eq!(prefs.cue_model_override, None);
        assert_eq!(prefs.effective_cue_model, "claude-haiku-5-5");
    }
}
