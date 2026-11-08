fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "snapshot",
            "start_demo",
            "pause_demo",
            "resume_demo",
            "end_demo",
            "respond_to_cue",
            "update_notes",
            "set_sensitivity",
            "set_overlay",
            "export_markdown",
            "export_preview",
            "microphone_snapshot",
            "start_microphone",
            "stop_microphone",
        ]),
    ))
    .expect("Tauri build configuration failed");
}
