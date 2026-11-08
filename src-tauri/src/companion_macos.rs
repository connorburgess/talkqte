//! Keep AppKit's rounded window frame while drawing the companion edge to edge.
//! An opaque full-size content view avoids WebKit transparency/private APIs.
use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWindowButton};
use tauri::Manager;

pub fn configure(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    if let Some(window) = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|w| w.label == "cue")
    {
        // Tauri creates the native titled frame before attaching the webview.
        // Borderless windows have a rectangular outer silhouette on macOS.
        window.decorations = true;
        window.title_bar_style = tauri::TitleBarStyle::Overlay;
        window.hidden_title = true;
    }
    context
}

pub fn hide_controls(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let _main = MainThreadMarker::new()
        .ok_or_else(|| std::io::Error::other("Companion setup requires the main thread."))?;
    let window = app
        .get_webview_window("cue")
        .ok_or_else(|| std::io::Error::other("Companion window is unavailable."))?;
    // SAFETY: Tauri owns this NSWindow throughout setup, which is on the main
    // thread. The companion is initially hidden, so controls never flash onscreen.
    let native = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(control) = native.standardWindowButton(button) {
            control.setHidden(true);
        }
    }
    Ok(())
}
