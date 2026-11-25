//! TalkQTE in the macOS menu bar: a status item with the mark, showing
//! whether a session is running, and a short menu. It lets TalkQTE stay
//! running with the notebook closed, when the person has turned on "Keep
//! running in the menu bar".
//!
//! The menu never starts, approves or captures anything: Start session…
//! opens the notebook's ordinary start, where the person chooses what to
//! listen to and approves processing as always. Stop ends a running session
//! as the notebook's Stop does. The call-starting offer's switch is the same
//! setting as in Settings.

// The status item and login items are macOS's; elsewhere only the
// shared model is compiled.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::Mutex;

/// What the menu shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    /// A live session is starting, running or finishing.
    pub session_open: bool,
    /// A running session that Stop would end.
    pub stoppable: bool,
    /// The call-starting offer is on.
    pub offer: bool,
}

pub const OPEN: &str = "menu-bar:open";
pub const START: &str = "menu-bar:start";
pub const STOP: &str = "menu-bar:stop";
pub const OFFER: &str = "menu-bar:offer";
pub const QUIT: &str = "menu-bar:quit";

/// One line of the menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Item {
    /// A line that only says something.
    Note(&'static str),
    Separator,
    Action {
        id: &'static str,
        label: &'static str,
        enabled: bool,
    },
    Check {
        id: &'static str,
        label: &'static str,
        checked: bool,
    },
}

/// The menu for `state`.
pub fn items(state: State) -> Vec<Item> {
    let mut items = vec![
        Item::Note(if state.session_open {
            "Session running"
        } else {
            "No session running"
        }),
        Item::Separator,
        Item::Action {
            id: OPEN,
            label: "Open notebook",
            enabled: true,
        },
        Item::Action {
            id: START,
            label: "Start session…",
            enabled: !state.session_open,
        },
    ];
    if state.stoppable {
        items.push(Item::Action {
            id: STOP,
            label: "Stop session",
            enabled: true,
        });
    }
    items.extend([
        Item::Separator,
        Item::Check {
            id: OFFER,
            label: "Offer to start when a call starts",
            checked: state.offer,
        },
        Item::Separator,
        Item::Action {
            id: QUIT,
            label: "Quit TalkQTE",
            enabled: true,
        },
    ]);
    items
}

pub fn tooltip(state: State) -> &'static str {
    if state.session_open {
        "TalkQTE · session running"
    } else {
        "TalkQTE"
    }
}

/// Side of the status item's image, in pixels: 18 points at 2×.
pub const ICON_SIZE: u32 = 36;

/// The mark as a menu bar template image (RGBA, black with coverage as
/// alpha, so macOS tints it for light and dark menu bars): the two
/// viewfinder corners and the cue bar of the 32-unit mark, without its
/// tile. With a session running the bar is solid and a dot appears at the
/// top right; otherwise the bar is faint.
pub fn icon(session_open: bool) -> Vec<u8> {
    // Rectangles in mark units (x0, y0, x1, y1), with the strength of each.
    let shapes: [([f32; 4], f32); 5] = [
        // ┌: the stroked path M8 13 V8 H13, 2.4 wide, square caps.
        ([6.8, 6.8, 14.2, 9.2], 1.0),
        ([6.8, 6.8, 9.2, 14.2], 1.0),
        // ┘: M24 19 V24 H19.
        ([22.8, 17.8, 25.2, 25.2], 1.0),
        ([17.8, 22.8, 25.2, 25.2], 1.0),
        // The cue bar.
        (
            [10.5, 14.5, 21.5, 17.5],
            if session_open { 1.0 } else { 0.45 },
        ),
    ];
    let dot = session_open.then_some((26.5_f32, 5.5_f32, 2.6_f32));
    let scale = 32.0 / ICON_SIZE as f32;
    const SAMPLES: u32 = 4;
    let mut rgba = vec![0u8; (ICON_SIZE * ICON_SIZE * 4) as usize];
    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let mut cover = 0.0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let u = (x as f32 + (sx as f32 + 0.5) / SAMPLES as f32) * scale;
                    let v = (y as f32 + (sy as f32 + 0.5) / SAMPLES as f32) * scale;
                    let mut strength: f32 = 0.0;
                    for ([x0, y0, x1, y1], alpha) in &shapes {
                        if u >= *x0 && u < *x1 && v >= *y0 && v < *y1 {
                            strength = strength.max(*alpha);
                        }
                    }
                    if let Some((cx, cy, r)) = dot {
                        if (u - cx).powi(2) + (v - cy).powi(2) <= r * r {
                            strength = 1.0;
                        }
                    }
                    cover += strength;
                }
            }
            let alpha = cover / (SAMPLES * SAMPLES) as f32;
            rgba[((y * ICON_SIZE + x) * 4 + 3) as usize] = (alpha * 255.0).round() as u8;
        }
    }
    rgba
}

/// The state the menu last showed, so it is rebuilt only when it changes.
#[derive(Default)]
pub struct Shown(Mutex<Option<State>>);

/// What a close of the notebook window does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Close {
    /// Quit, as TalkQTE always has.
    Quit,
    /// Hide the notebook and keep running in the menu bar.
    Hide,
}

/// The person's "Keep running in the menu bar" choice decides; without a
/// menu bar item (another platform, or none could be made) it always quits,
/// so the app is never left running with no way back to it.
pub fn on_close(keep_running: bool, has_item: bool) -> Close {
    if keep_running && has_item {
        Close::Hide
    } else {
        Close::Quit
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use tauri::{
        image::Image,
        menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
        tray::TrayIconBuilder,
        AppHandle, Manager, Wry,
    };

    const ID: &str = "talkqte";

    fn menu(app: &AppHandle, state: State) -> tauri::Result<Menu<Wry>> {
        let mut built: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
        for item in items(state) {
            built.push(match item {
                Item::Note(text) => Box::new(MenuItem::with_id(
                    app,
                    "menu-bar:note",
                    text,
                    false,
                    None::<&str>,
                )?),
                Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Item::Action { id, label, enabled } => {
                    Box::new(MenuItem::with_id(app, id, label, enabled, None::<&str>)?)
                }
                Item::Check { id, label, checked } => Box::new(CheckMenuItem::with_id(
                    app,
                    id,
                    label,
                    true,
                    checked,
                    None::<&str>,
                )?),
            });
        }
        let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|item| item.as_ref()).collect();
        Menu::with_items(app, &refs)
    }

    fn image(state: State) -> Image<'static> {
        Image::new_owned(icon(state.session_open), ICON_SIZE, ICON_SIZE)
    }

    /// Adds the status item. Returns whether there is one.
    pub fn install(app: &AppHandle, state: State) -> bool {
        let built = menu(app, state).and_then(|menu| {
            TrayIconBuilder::with_id(ID)
                .icon(image(state))
                .icon_as_template(true)
                .tooltip(tooltip(state))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| super::chosen(app, event.id().as_ref()))
                .build(app)
        });
        if built.is_err() {
            return false;
        }
        if let Ok(mut shown) = app.state::<Shown>().0.lock() {
            *shown = Some(state);
        }
        true
    }

    /// Shows `state`, rebuilding the menu only when it changed.
    pub fn update(app: &AppHandle, state: State) {
        let Some(tray) = app.tray_by_id(ID) else {
            return;
        };
        {
            let shown = app.state::<Shown>();
            let Ok(mut shown) = shown.0.lock() else {
                return;
            };
            if *shown == Some(state) {
                return;
            }
            *shown = Some(state);
        }
        if let Ok(menu) = menu(app, state) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_icon(Some(image(state)));
        let _ = tray.set_icon_as_template(true);
        let _ = tray.set_tooltip(Some(tooltip(state)));
    }

    pub fn has_item(app: &AppHandle) -> bool {
        app.tray_by_id(ID).is_some()
    }

    /// The notebook comes back: in the Dock and the app switcher again.
    pub fn show_notebook(app: &AppHandle) {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }

    /// The notebook goes away and TalkQTE leaves the Dock, staying in the
    /// menu bar.
    pub fn hide_notebook(app: &AppHandle) {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

#[cfg(target_os = "macos")]
pub use native::{has_item, hide_notebook, install, show_notebook, update};

#[cfg(not(target_os = "macos"))]
pub fn install(_: &tauri::AppHandle, _: State) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn update(_: &tauri::AppHandle, _: State) {}
#[cfg(not(target_os = "macos"))]
pub fn has_item(_: &tauri::AppHandle) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn show_notebook(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}
#[cfg(not(target_os = "macos"))]
pub fn hide_notebook(_: &tauri::AppHandle) {}

/// The menu's state from the runtime.
pub(crate) fn state_of(runtime: &crate::Runtime) -> State {
    State {
        session_open: runtime.live_session_open(),
        stoppable: runtime.live.is_some(),
        offer: runtime.call_prompt.enabled(),
    }
}

/// Refreshes the menu from the runtime, without waiting on it.
pub(crate) fn refresh(app: &tauri::AppHandle) {
    use tauri::Manager;
    let state = match app.state::<crate::AppState>().0.try_lock() {
        Ok(runtime) => state_of(&runtime),
        Err(_) => return,
    };
    update(app, state);
}

/// A menu choice.
fn chosen(app: &tauri::AppHandle, id: &str) {
    use tauri::{Emitter, Manager};
    match id {
        OPEN => show_notebook(app),
        START => {
            // Only the notebook's ordinary start: nothing is chosen,
            // listed, approved or captured here.
            show_notebook(app);
            let _ = app.emit_to("main", "menu-bar:start-session", ());
        }
        STOP => crate::stop_live_from_menu(app),
        OFFER => {
            if crate::settings::lab_run() {
                return;
            }
            let settings = {
                let state = app.state::<crate::AppState>();
                let Ok(mut runtime) = state.0.lock() else {
                    return;
                };
                let enabled = !runtime.call_prompt.enabled();
                runtime.call_prompt.set_enabled(enabled);
                crate::settings_commands::record_call_prompt(app, &runtime.call_prompt);
                crate::publish(app, &mut runtime);
                runtime.call_prompt.settings().clone()
            };
            crate::companion::refresh(app);
            // The notebook's Settings shows the same switch.
            let _ = app.emit_to("main", "call-prompt:settings", settings);
            refresh(app);
        }
        QUIT => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(state: State) -> Vec<String> {
        items(state)
            .into_iter()
            .map(|item| match item {
                Item::Note(text) => format!("({text})"),
                Item::Separator => "—".into(),
                Item::Action { label, enabled, .. } => {
                    format!("{label}{}", if enabled { "" } else { " [off]" })
                }
                Item::Check { label, checked, .. } => {
                    format!("{}{label}", if checked { "✓ " } else { "" })
                }
            })
            .collect()
    }

    #[test]
    fn with_no_session_it_offers_the_notebook_and_its_start_but_no_stop() {
        assert_eq!(
            labels(State::default()),
            [
                "(No session running)",
                "—",
                "Open notebook",
                "Start session…",
                "—",
                "Offer to start when a call starts",
                "—",
                "Quit TalkQTE"
            ]
        );
    }

    #[test]
    fn a_running_session_shows_stop_and_cannot_be_started_again() {
        let running = State {
            session_open: true,
            stoppable: true,
            offer: true,
        };
        assert_eq!(
            labels(running),
            [
                "(Session running)",
                "—",
                "Open notebook",
                "Start session… [off]",
                "Stop session",
                "—",
                "✓ Offer to start when a call starts",
                "—",
                "Quit TalkQTE"
            ]
        );
        // Still starting: nothing to stop yet, and no second start.
        let starting = State {
            stoppable: false,
            ..running
        };
        assert!(!labels(starting).contains(&"Stop session".to_string()));
        assert!(labels(starting).contains(&"Start session… [off]".to_string()));
        assert_eq!(tooltip(running), "TalkQTE · session running");
    }

    #[test]
    fn closing_the_notebook_quits_unless_the_person_chose_the_menu_bar() {
        assert_eq!(on_close(false, true), Close::Quit);
        assert_eq!(on_close(true, true), Close::Hide);
        // Never hidden with no way back.
        assert_eq!(on_close(true, false), Close::Quit);
    }

    #[test]
    fn the_icon_is_a_template_that_shows_whether_a_session_runs() {
        let idle = icon(false);
        let running = icon(true);
        assert_eq!(idle.len(), (ICON_SIZE * ICON_SIZE * 4) as usize);
        // Black only: macOS tints a template image from its alpha.
        assert!(idle
            .chunks(4)
            .chain(running.chunks(4))
            .all(|pixel| pixel[..3] == [0, 0, 0]));
        let ink = |image: &[u8]| image.chunks(4).map(|pixel| pixel[3] as u32).sum::<u32>();
        assert!(ink(&idle) > 0);
        assert!(ink(&running) > ink(&idle));
        // The middle of the cue bar: faint at rest, solid while running.
        let middle = (((ICON_SIZE / 2) * ICON_SIZE + ICON_SIZE / 2) * 4 + 3) as usize;
        assert!(idle[middle] < 160 && running[middle] == 255);
    }
}
