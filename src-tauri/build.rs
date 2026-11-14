/// The development-only application-audio command exists, and is allowed,
/// only in a macOS build with the `native-audio-spike` feature.
fn with_development_commands(commands: &[&'static str]) -> &'static [&'static str] {
    let mut commands = commands.to_vec();
    if std::env::var_os("CARGO_FEATURE_NATIVE_AUDIO_SPIKE").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
    {
        commands.push("application_audio");
    }
    commands.leak()
}

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(with_development_commands(&[
            "snapshot",
            "processing_snapshot",
            "stop_capture",
            "review_processing_scope",
            "approve_processing_scope",
            "cancel_processing_review",
            "revoke_processing",
            "set_processing_paused",
            "set_live_cues_paused",
            "respond_to_cue",
            "inspect_cue",
            "set_companion_position",
            "set_question_size",
            "update_notes",
            "set_sensitivity",
            "set_user_name",
            "set_focus",
            "set_overlay",
            "export_markdown",
            "export_preview",
            "microphone_snapshot",
            "start_microphone",
            "stop_microphone",
            "live_status",
            "model_status",
            "pick_context_file",
            "import_context_notes",
            "cancel_context_import",
            "context_items",
            "remove_context_item",
            "remove_context_from",
            "connect_granola",
            "cancel_granola_sign_in",
            "granola_status",
            "list_granola_notes",
            "disconnect_granola",
            "suggest_granola_focus",
            "check_granola_updates",
            "stop_granola_update_check",
            "download_model",
            "cancel_model_download",
            "remove_model",
            "start_live_session",
            "stop_live_session",
        ])),
    ))
    .expect("Tauri build configuration failed");
}
