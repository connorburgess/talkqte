//! Keep AppKit's rounded window frame while drawing the companion edge to edge.
//! An opaque full-size content view avoids WebKit transparency/private APIs.
use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowCollectionBehavior};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
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

/// Where the companion goes on every Space, including over other apps'
/// full-screen windows: joining all Spaces, as an auxiliary to full-screen
/// windows, and out of the Cmd-` window cycle. It stays non-activating, so
/// showing it never takes focus from the app the person is using.
const ON_EVERY_SPACE: NSWindowCollectionBehavior = NSWindowCollectionBehavior::CanJoinAllSpaces
    .union(NSWindowCollectionBehavior::FullScreenAuxiliary)
    .union(NSWindowCollectionBehavior::IgnoresCycle);

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
    // A cue is for the conversation the person is in, whichever Space or
    // full-screen app they are working in.
    native.setCollectionBehavior(ON_EVERY_SPACE);
    Ok(())
}

/// Moves and resizes the companion in one AppKit frame change, so no
/// in-between frame (moved but not yet resized) is ever on screen or seen
/// by another process. `frame` is in physical pixels with a top-left origin,
/// on a display of `scale`. Runs on the main thread.
pub fn set_frame(
    window: &tauri::WebviewWindow,
    frame: (i32, i32, u32, u32),
    scale: f64,
) -> Result<(), ()> {
    let primary = window.primary_monitor().ok().flatten().ok_or(())?;
    let primary_height = f64::from(primary.size().height) / primary.scale_factor();
    let rect = appkit_rect(frame, scale, primary_height);
    // SAFETY: Tauri owns this NSWindow, and `refresh` calls this on the main thread.
    let native = unsafe { &*window.ns_window().map_err(|_| ())?.cast::<NSWindow>() };
    native.setFrame_display(rect, true);
    Ok(())
}

/// A top-left physical frame as AppKit's bottom-left point rectangle, given
/// the display's scale and the primary display's height in points.
fn appkit_rect(frame: (i32, i32, u32, u32), scale: f64, primary_height: f64) -> CGRect {
    let (x, y, width, height) = frame;
    let (x, y) = (f64::from(x) / scale, f64::from(y) / scale);
    let (width, height) = (f64::from(width) / scale, f64::from(height) / scale);
    CGRect::new(
        CGPoint::new(x, primary_height - (y + height)),
        CGSize::new(width, height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_top_left_frame_becomes_the_same_place_in_appkit_points() {
        // A Retina primary display 900 points high; the companion's bar at
        // bottom right, 320x76 points, 24 points above the bottom.
        let rect = appkit_rect((2_160, 1_600, 640, 152), 2.0, 900.0);
        assert_eq!(rect.origin, CGPoint::new(1_080.0, 24.0));
        assert_eq!(rect.size, CGSize::new(320.0, 76.0));
        // A display above the primary one has negative top-left y; it is
        // above the primary's top in AppKit too.
        let above = appkit_rect((0, -1_000, 320, 76), 1.0, 900.0);
        assert_eq!(above.origin, CGPoint::new(0.0, 1_824.0));
        // A display to the left has negative x in both systems.
        let left = appkit_rect((-1_280, 0, 320, 76), 1.0, 900.0);
        assert_eq!(left.origin, CGPoint::new(-1_280.0, 824.0));
    }

    #[test]
    fn the_companion_joins_every_space_and_full_screen_apps_without_entering_the_window_cycle() {
        for needed in [
            NSWindowCollectionBehavior::CanJoinAllSpaces,
            NSWindowCollectionBehavior::FullScreenAuxiliary,
            NSWindowCollectionBehavior::IgnoresCycle,
        ] {
            assert!(ON_EVERY_SPACE.contains(needed));
        }
        // Not moved by Mission Control's own Space, and never a full-screen
        // window of its own.
        assert!(!ON_EVERY_SPACE.contains(NSWindowCollectionBehavior::MoveToActiveSpace));
        assert!(!ON_EVERY_SPACE.contains(NSWindowCollectionBehavior::FullScreenPrimary));
    }
}
