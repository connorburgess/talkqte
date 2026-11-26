//! Keep AppKit's rounded window frame while drawing the companion edge to edge.
//! An opaque full-size content view avoids WebKit transparency/private APIs.
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{
    NSStatusWindowLevel, NSWindow, NSWindowButton, NSWindowCollectionBehavior, NSWindowLevel,
    NSWorkspace,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use std::ffi::c_void;
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

/// Float at status level so the companion stays above normal, floating, and
/// picture-in-picture browser/meeting windows across Spaces and full-screen
/// apps without obscuring pop-up menus.
const COMPANION_WINDOW_LEVEL: NSWindowLevel = NSStatusWindowLevel;

/// Where the companion goes on every Space, including over other apps'
/// full-screen windows: joining all Spaces, as an auxiliary to full-screen
/// windows, and out of the Cmd-` window cycle. It is an ordinary window
/// that cannot take focus (`focusable: false`), ordered front with
/// `orderFrontRegardless` so showing it never activates TalkQTE or steals focus.
const ON_EVERY_SPACE: NSWindowCollectionBehavior = NSWindowCollectionBehavior::CanJoinAllSpaces
    .union(NSWindowCollectionBehavior::FullScreenAuxiliary)
    .union(NSWindowCollectionBehavior::IgnoresCycle);

/// Logical top-left Quartz rectangle `(x, y, width, height)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ActiveDisplaySignals {
    /// Whether TalkQTE itself is currently the frontmost application.
    pub frontmost_is_self: bool,
    /// Frontmost onscreen normal-layer window of the active non-self
    /// application, in Quartz top-left logical coordinates.
    pub frontmost_window: Option<LogicalRect>,
    /// Current pointer location in Quartz top-left logical coordinates.
    pub cursor: Option<(f64, f64)>,
}

fn is_self_bundle(bundle_id: &str) -> bool {
    bundle_id == "com.talkqte.desktop"
        || bundle_id.starts_with("com.talkqte.")
        || bundle_id.starts_with("app.talkqte.")
}

fn apply_floating_attributes(native: &NSWindow) {
    if native.level() != COMPANION_WINDOW_LEVEL {
        native.setLevel(COMPANION_WINDOW_LEVEL);
    }
    if native.collectionBehavior() != ON_EVERY_SPACE {
        native.setCollectionBehavior(ON_EVERY_SPACE);
    }
    if native.hidesOnDeactivate() {
        native.setHidesOnDeactivate(false);
    }
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
    // A cue is for the conversation the person is in, whichever Space or
    // full-screen app they are working in.
    apply_floating_attributes(native);
    Ok(())
}

/// Shows or re-orders the companion above other apps' windows without making it
/// key or activating TalkQTE. `Tauri`'s `window.show()` calls
/// `makeKeyAndOrderFront:`, which does not order a non-keyable window above an
/// active foreground browser or full-screen Space.
pub fn show(window: &tauri::WebviewWindow) -> Result<(), ()> {
    MainThreadMarker::new().ok_or(())?;
    // SAFETY: Tauri owns this NSWindow, and this runs on the main thread.
    let native = unsafe { &*window.ns_window().map_err(|_| ())?.cast::<NSWindow>() };
    apply_floating_attributes(native);
    native.orderFrontRegardless();
    Ok(())
}

/// Re-asserts floating level, Space behavior, and front-of-level order so a
/// Space switch or full-screen browser cannot leave the companion hidden behind
/// another window.
pub fn ensure_front(window: &tauri::WebviewWindow) {
    let _ = show(window);
}

/// Reads the frontmost app's active window bounds and the cursor position in
/// Quartz top-left logical coordinates, using `primary_height` (points) to
/// convert AppKit's bottom-left cursor coordinate. Must run on the main thread.
pub fn active_display_signals(primary_height: Option<f64>) -> ActiveDisplaySignals {
    if MainThreadMarker::new().is_none() {
        return ActiveDisplaySignals::default();
    }
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: `NSEvent.mouseLocation` is a class method returning an
        // NSPoint (identical ABI to CGPoint on 64-bit macOS) in global AppKit
        // bottom-left coordinates.
        let mouse: CGPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
        let cursor = primary_height
            .filter(|h| h.is_finite() && *h > 0.0)
            .filter(|_| mouse.x.is_finite() && mouse.y.is_finite())
            .map(|h| (mouse.x, h - mouse.y));

        let workspace = NSWorkspace::sharedWorkspace();
        let Some(app) = workspace.frontmostApplication() else {
            return ActiveDisplaySignals {
                frontmost_is_self: false,
                frontmost_window: None,
                cursor,
            };
        };
        let pid = app.processIdentifier();
        let self_pid = i32::try_from(std::process::id()).unwrap_or(-1);
        let bundle_id = app.bundleIdentifier().map(|id| id.to_string());
        let frontmost_is_self = pid == self_pid || bundle_id.as_deref().is_some_and(is_self_bundle);
        let frontmost_window = if frontmost_is_self || pid <= 0 {
            None
        } else {
            frontmost_window_bounds(pid)
        };
        ActiveDisplaySignals {
            frontmost_is_self,
            frontmost_window,
            cursor,
        }
    })
}

fn frontmost_window_bounds(pid: i32) -> Option<LogicalRect> {
    // kCGWindowListOptionOnScreenOnly (1 << 0) | kCGWindowListExcludeDesktopElements (1 << 4)
    const WINDOW_LIST_OPTIONS: u32 = (1 << 0) | (1 << 4);
    const NULL_WINDOW_ID: u32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        static kCGWindowOwnerPID: *const NSString;
        static kCGWindowLayer: *const NSString;
        static kCGWindowAlpha: *const NSString;
        static kCGWindowBounds: *const NSString;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut c_void;
        fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
    }

    // SAFETY: CoreGraphics exports these constant CFStringRef keys and
    // CGWindowListCopyWindowInfo returns a +1 retained CFArrayRef (toll-free
    // bridged to NSArray) or null.
    let windows: Retained<NSArray<NSDictionary<NSString, AnyObject>>> = unsafe {
        let raw = CGWindowListCopyWindowInfo(WINDOW_LIST_OPTIONS, NULL_WINDOW_ID);
        if raw.is_null() {
            return None;
        }
        Retained::from_raw(raw.cast())?
    };

    // SAFETY: CoreGraphics constant CFStringRefs are non-null static strings
    // toll-free bridged to NSString for the lifetime of the process.
    let (key_pid, key_layer, key_alpha, key_bounds) = unsafe {
        if kCGWindowOwnerPID.is_null()
            || kCGWindowLayer.is_null()
            || kCGWindowAlpha.is_null()
            || kCGWindowBounds.is_null()
        {
            return None;
        }
        (
            &*kCGWindowOwnerPID,
            &*kCGWindowLayer,
            &*kCGWindowAlpha,
            &*kCGWindowBounds,
        )
    };

    for entry in windows.iter() {
        let owner_pid = entry
            .objectForKey(key_pid)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.intValue());
        if owner_pid != Some(pid) {
            continue;
        }
        let layer = entry
            .objectForKey(key_layer)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.intValue());
        if layer != Some(0) {
            continue;
        }
        let alpha = entry
            .objectForKey(key_alpha)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.doubleValue())
            .unwrap_or(1.0);
        if alpha <= 0.0 {
            continue;
        }
        let Some(bounds) = entry.objectForKey(key_bounds) else {
            continue;
        };
        let mut rect = CGRect::ZERO;
        // SAFETY: `bounds` is the CoreGraphics bounds dictionary value for this window entry.
        let ok = unsafe {
            CGRectMakeWithDictionaryRepresentation(Retained::as_ptr(&bounds).cast(), &mut rect)
        };
        // Ignore tiny 1x1 or offscreen helper windows created by browsers.
        if !ok || rect.size.width < 50.0 || rect.size.height < 50.0 {
            continue;
        }
        return Some(LogicalRect {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        });
    }
    None
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
    // Off the main thread, fall back to Tauri's own calls, which dispatch.
    MainThreadMarker::new().ok_or(())?;
    // SAFETY: Tauri owns this NSWindow, and this is the main thread.
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
    use objc2_app_kit::{NSFloatingWindowLevel, NSMainMenuWindowLevel, NSPopUpMenuWindowLevel};

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

    #[test]
    fn the_companion_floats_at_status_level_above_browser_windows_and_below_menus() {
        assert_eq!(COMPANION_WINDOW_LEVEL, NSStatusWindowLevel);
        assert!(COMPANION_WINDOW_LEVEL > NSFloatingWindowLevel);
        assert!(COMPANION_WINDOW_LEVEL > NSMainMenuWindowLevel);
        assert!(COMPANION_WINDOW_LEVEL < NSPopUpMenuWindowLevel);
    }

    #[test]
    fn self_bundle_recognition_matches_talkqte_identifiers() {
        assert!(is_self_bundle("com.talkqte.desktop"));
        assert!(is_self_bundle("com.talkqte.native-validation"));
        assert!(is_self_bundle("app.talkqte.desktop"));
        assert!(!is_self_bundle("com.google.Chrome"));
        assert!(!is_self_bundle("us.zoom.xos"));
    }
}
