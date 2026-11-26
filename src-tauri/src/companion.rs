//! Native placement stays outside the engine lock. All window queries run on
//! the main thread so a command cannot deadlock while waiting for that thread.
use crate::{
    engine::{CompanionPosition, CueSnapshot, QuestionSize, Status},
    microphone::{Controller as Microphone, Status as MicrophoneStatus},
    AppState,
};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Hidden,
    Compact,
    /// A compact call-starting offer when no session is running.
    Prompt,
    /// A cue is showing. The window is one size for it, held or answered.
    Question,
}

impl Mode {
    pub fn for_snapshot(state: &CueSnapshot, microphone: MicrophoneStatus) -> Self {
        if !state.overlay_enabled {
            Self::Hidden
        } else if state.cue.is_some()
            || state.calendar_prompt.is_some()
            || state.end_prompt.is_some()
            || state.call_end_prompt.is_some()
        {
            Self::Question
        } else if state.call_prompt.is_some() {
            Self::Prompt
        } else if microphone == MicrophoneStatus::Off
            && matches!(state.status, Status::Ready | Status::Ended)
        {
            Self::Hidden
        } else {
            Self::Compact
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Frame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

// Physical coordinates include negative origins for monitors left/above the
// primary display. Clamp each dimension before anchoring on small work areas.
/// The preset frame for a mode, as the tests describe it.
#[cfg(test)]
fn frame(
    origin: (i32, i32),
    area: (u32, u32),
    scale: f64,
    mode: Mode,
    position: CompanionPosition,
    text_size: QuestionSize,
) -> Frame {
    frame_at(origin, area, scale, mode, position, text_size, None)
}

/// The companion's width in logical pixels, the bar's and a cue's alike, so
/// a cue grows out of the bar without the window changing its width. A cue
/// is a small prompt beside a call: about 30 characters a line at the
/// companion's 17 px cue size (an estimate from the font), far inside the
/// 80 characters WCAG 2.2 SC 1.4.8 asks a block of text to be kept within.
const COMPACT_WIDTH: f64 = 320.0;

/// A cue's height in logical pixels: an ordinary cue and the one line it
/// cites fit without scrolling. Large text adds `LARGE_EXTRA`.
const QUESTION_HEIGHT: f64 = 232.0;
/// Compact height of the call-starting offer in logical pixels. Large text
/// adds `LARGE_EXTRA`.
const PROMPT_HEIGHT: f64 = 160.0;
const LARGE_EXTRA: f64 = 44.0;

/// The companion's frame for a mode. A position the person dragged the
/// window to wins over the Settings preset: its top-left corner is kept,
/// pulled back inside the work area when the window grows or the display
/// changes.
fn frame_at(
    origin: (i32, i32),
    area: (u32, u32),
    scale: f64,
    mode: Mode,
    position: CompanionPosition,
    text_size: QuestionSize,
    dragged: Option<(i32, i32)>,
) -> Frame {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let margin = (20.0 * scale).round() as u32;
    let question = matches!(mode, Mode::Question | Mode::Prompt);
    let logical_width = COMPACT_WIDTH;
    let width =
        ((logical_width * scale).round() as u32).min(area.0.saturating_sub(2 * margin).max(1));
    let logical_height = match mode {
        Mode::Question => QUESTION_HEIGHT,
        Mode::Prompt => PROMPT_HEIGHT,
        _ => 76.0,
    } + if question && text_size == QuestionSize::Large {
        // Large text wraps more in the narrow window.
        LARGE_EXTRA
    } else {
        0.0
    };
    let height =
        ((logical_height * scale).round() as u32).min(area.1.saturating_sub(2 * margin).max(1));
    let left = margin.min(area.0.saturating_sub(width));
    let right = area.0.saturating_sub(width + margin);
    let top = margin.min(area.1.saturating_sub(height));
    let x = match position {
        CompanionPosition::BottomRight | CompanionPosition::TopRight => right,
        CompanionPosition::TopLeft => left,
        CompanionPosition::TopCenter => area.0.saturating_sub(width) / 2,
    };
    let y = if position == CompanionPosition::BottomRight {
        area.1.saturating_sub(height + margin)
    } else {
        top
    };
    let (x, y) = match dragged {
        Some((dx, dy)) => (
            i64::from(dx).clamp(
                i64::from(origin.0),
                i64::from(origin.0) + i64::from(area.0.saturating_sub(width)),
            ),
            i64::from(dy).clamp(
                i64::from(origin.1),
                i64::from(origin.1) + i64::from(area.1.saturating_sub(height)),
            ),
        ),
        None => (
            i64::from(origin.0) + i64::from(x),
            i64::from(origin.1) + i64::from(y),
        ),
    };
    Frame {
        x: x.clamp(i32::MIN.into(), i32::MAX.into()) as i32,
        y: y.clamp(i32::MIN.into(), i32::MAX.into()) as i32,
        width,
        height,
    }
}

/// Whether the window keeps its bottom edge when it grows: the bottom-right
/// preset does, unless the person dragged the window, whose top-left corner
/// is then kept. The page puts the bar on that edge, so a cue grows out of
/// the bar without the bar moving on screen.
fn anchored_at_bottom(position: CompanionPosition, dragged: Option<(i32, i32)>) -> bool {
    position == CompanionPosition::BottomRight && dragged.is_none()
}

/// The edge the companion window keeps, as the page names it.
fn edge(position: CompanionPosition, dragged: Option<(i32, i32)>) -> &'static str {
    if anchored_at_bottom(position, dragged) {
        "bottom"
    } else {
        "top"
    }
}

/// The edge the companion window keeps when it grows, for a page that has
/// just loaded: a reload with a cue showing, or a frame change before the
/// page listened, would otherwise leave the bar on the wrong edge until the
/// next move. Locks are taken one at a time, as in `refresh`.
#[tauri::command]
pub fn companion_anchor(
    state: tauri::State<AppState>,
    window: tauri::State<WindowState>,
) -> Result<&'static str, String> {
    let position = state
        .0
        .lock()
        .map_err(|_| "The session is unavailable.")?
        .engine
        .state
        .companion_position;
    let dragged = window
        .0
        .lock()
        .map_err(|_| "The companion is unavailable.")?
        .dragged;
    Ok(edge(position, dragged))
}

#[derive(Default)]
pub struct Placement {
    /// The mode and frame last applied to the window.
    applied: Option<(Mode, Option<Frame>)>,
    /// The top-left corner the person dragged the window to, in physical
    /// pixels, until a Settings preset replaces it. Session only.
    dragged: Option<(i32, i32)>,
    /// The position our own move will end at, and when it was requested.
    /// Moved events until then are the window settling (a resize moves the
    /// top-left corner first, then the move lands), not a drag; after
    /// SETTLE_MS without the expected position they count again, so a move
    /// the system refused cannot swallow later drags.
    expected: Option<((i32, i32), Instant)>,
    /// When a cue was first seen gone while the window was still at its
    /// size, until the window returns to the bar.
    leaving: Option<Instant>,
}

/// How long the app's own move may take to land.
const SETTLE_MS: u64 = 1_000;

/// How long the window keeps a cue's size after the cue goes, so the card's
/// leaving animation (190 ms in `cue-card.css`) finishes inside it.
const LEAVE_MS: u64 = 220;
// The wait covers the animation, and stays too short to read as a pause.
const _: () = assert!(LEAVE_MS >= 190 && LEAVE_MS <= 300);

#[derive(Default)]
pub struct WindowState(Mutex<Placement>);

impl Placement {
    /// A cue has gone and the bar is about to replace it. Returns how much
    /// longer the window should keep the cue's size, or None to resize now:
    /// when motion is reduced, when there was no cue, when another cue has
    /// arrived, or when the companion is being hidden altogether.
    fn leave_wait(&mut self, mode: Mode, now: Instant, reduce_motion: bool) -> Option<Duration> {
        let was_cue = self
            .applied
            .is_some_and(|(applied, _)| applied == Mode::Question);
        if reduce_motion || !was_cue || mode != Mode::Compact {
            self.leaving = None;
            return None;
        }
        let waited = now.duration_since(*self.leaving.get_or_insert(now));
        let wait = Duration::from_millis(LEAVE_MS).checked_sub(waited);
        match wait {
            Some(left) if !left.is_zero() => Some(left),
            _ => {
                self.leaving = None;
                None
            }
        }
    }

    /// Records a Moved event. Returns true when it was a drag by the person.
    fn note_move(&mut self, position: (i32, i32), now: Instant) -> bool {
        if let Some((expected, since)) = self.expected {
            if position == expected {
                self.expected = None;
                return false;
            }
            if now.duration_since(since) < Duration::from_millis(SETTLE_MS) {
                return false;
            }
            self.expected = None;
        }
        let ours = self
            .applied
            .and_then(|(_, frame)| frame)
            .is_some_and(|frame| (frame.x, frame.y) == position);
        if ours {
            return false;
        }
        self.dragged = Some(position);
        // Reapply on the next refresh so a grown window stays on the display.
        self.applied = None;
        true
    }
}

/// The companion window reported a new position. One the app did not ask
/// for is a drag by the person, and is kept from then on.
pub fn moved(app: &tauri::AppHandle, position: (i32, i32)) {
    if let Ok(mut placement) = app.state::<WindowState>().0.lock() {
        placement.note_move(position, Instant::now());
    }
}

/// A Settings preset was chosen: forget the dragged position.
pub fn reset_drag(app: &tauri::AppHandle) {
    if let Ok(mut placement) = app.state::<WindowState>().0.lock() {
        placement.dragged = None;
        placement.applied = None;
    }
}

/// Whether the system asks for reduced motion. Only macOS is asked; other
/// platforms resize at once, as they did before the leaving animation.
#[cfg(target_os = "macos")]
fn reduce_motion() -> bool {
    use objc2::{class, msg_send, runtime::AnyObject};
    // SAFETY: `refresh` calls this on the main thread. NSWorkspace's shared
    // instance lives for the whole process, and the property is a plain BOOL.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        !workspace.is_null() && msg_send![workspace, accessibilityDisplayShouldReduceMotion]
    }
}

#[cfg(not(target_os = "macos"))]
fn reduce_motion() -> bool {
    true
}

pub fn refresh(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let cue = {
            let state = handle.state::<AppState>();
            let Ok(runtime) = state.0.lock() else { return };
            runtime.cue_snapshot()
        }; // Release the engine lock before every native window operation.
        let Some(microphone) = handle.state::<Microphone>().try_status() else {
            return;
        };
        let mode = Mode::for_snapshot(&cue, microphone);
        let Some(window) = handle.get_webview_window("cue") else {
            return;
        };
        let state = handle.state::<WindowState>();
        let Ok(mut placement) = state.0.lock() else {
            return;
        };
        // Let a leaving cue fold away before the window shrinks to the bar.
        let already_waiting = placement.leaving.is_some();
        if let Some(wait) = placement.leave_wait(mode, Instant::now(), reduce_motion()) {
            if !already_waiting {
                let later = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(wait);
                    refresh(&later);
                });
            }
            return;
        }
        let mut scale = 1.0;
        let layout = if mode == Mode::Hidden {
            None
        } else {
            // Follow the active display (frontmost call/browser app or cursor),
            // falling back to the notebook's display and then primary.
            let Some(monitor) = select_monitor(&handle, &window) else {
                return;
            };
            let area = monitor.work_area();
            scale = monitor.scale_factor();
            Some(frame_at(
                (area.position.x, area.position.y),
                (area.size.width, area.size.height),
                monitor.scale_factor(),
                mode,
                cue.companion_position,
                cue.question_size,
                placement.dragged,
            ))
        };
        let currently_visible = window.is_visible().unwrap_or(false);
        if !should_apply(placement.applied, mode, layout, currently_visible) {
            if layout.is_some() {
                ensure_front(&window);
            }
            return;
        }
        placement.expected = layout.map(|frame| ((frame.x, frame.y), Instant::now()));
        if layout.is_some() {
            // Before the frame changes, so the page has the bar on the edge
            // that stays put. It rarely changes: only with a preset or a drag.
            let _ = window.emit(
                "companion:anchor",
                edge(cue.companion_position, placement.dragged),
            );
        }
        let result = if let Some(frame) = layout {
            set_frame(&window, frame, scale).and_then(|_| show_window(&window))
        } else {
            window.hide()
        };
        if result.is_ok() {
            placement.applied = Some((mode, layout));
        }
    });
}

/// Whether the window must be updated (`show` / `hide` / frame change).
/// Never treats an actually-hidden window as already applied for a visible
/// mode so the companion cannot silently stay hidden.
fn should_apply(
    applied: Option<(Mode, Option<Frame>)>,
    mode: Mode,
    layout: Option<Frame>,
    currently_visible: bool,
) -> bool {
    if applied != Some((mode, layout)) {
        return true;
    }
    if layout.is_some() {
        !currently_visible
    } else {
        currently_visible
    }
}

/// Display rectangle in top-left global coordinates matching the active
/// platform's pointer/window query coordinates (logical points on macOS,
/// physical pixels elsewhere).
#[derive(Clone, Copy, Debug, PartialEq)]
struct MonitorBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct ActiveDisplayHint {
    frontmost_is_self: bool,
    frontmost_window: Option<MonitorBounds>,
    cursor: Option<(f64, f64)>,
    main_monitor: Option<usize>,
    main_visible: bool,
    main_focused: bool,
    companion_monitor: Option<usize>,
    primary_monitor: Option<usize>,
}

fn monitor_containing_point(monitors: &[MonitorBounds], (px, py): (f64, f64)) -> Option<usize> {
    if !px.is_finite() || !py.is_finite() {
        return None;
    }
    monitors
        .iter()
        .position(|m| px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height)
        .or_else(|| {
            monitors
                .iter()
                .position(|m| px >= m.x && px <= m.x + m.width && py >= m.y && py <= m.y + m.height)
        })
}

fn monitor_for_rect(monitors: &[MonitorBounds], rect: MonitorBounds) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (idx, m) in monitors.iter().enumerate() {
        let ix = (m.x + m.width).min(rect.x + rect.width) - m.x.max(rect.x);
        let iy = (m.y + m.height).min(rect.y + rect.height) - m.y.max(rect.y);
        let area = ix.max(0.0) * iy.max(0.0);
        if area > 0.0 && best.is_none_or(|(_, best_area)| area > best_area) {
            best = Some((idx, area));
        }
    }
    best.map(|(idx, _)| idx).or_else(|| {
        monitor_containing_point(
            monitors,
            (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0),
        )
    })
}

/// Chooses the monitor index for the companion dock.
///
/// Priority:
/// 1. When TalkQTE itself is frontmost and the `main` notebook window is
///    visible and focused, anchor to `main`'s monitor.
/// 2. When another app (such as Chrome or Zoom) is frontmost with an onscreen
///    window, anchor to the display containing that window.
/// 3. Otherwise anchor to the monitor containing the mouse cursor (which also
///    keeps the companion on the call's display when clicked while `main` is
///    hidden or unfocused).
/// 4. Fall back to a visible `main`, `companion_monitor`, `main_monitor`,
///    `primary_monitor`, or the first available monitor.
fn select_monitor_index(monitors: &[MonitorBounds], hint: &ActiveDisplayHint) -> Option<usize> {
    if monitors.is_empty() {
        return None;
    }
    let valid = |idx: Option<usize>| idx.filter(|&i| i < monitors.len());

    if hint.frontmost_is_self && hint.main_visible && hint.main_focused {
        if let Some(idx) = valid(hint.main_monitor) {
            return Some(idx);
        }
    }
    if let Some(rect) = hint.frontmost_window {
        if let Some(idx) = monitor_for_rect(monitors, rect) {
            return Some(idx);
        }
    }
    if let Some(cursor) = hint.cursor {
        if let Some(idx) = monitor_containing_point(monitors, cursor) {
            return Some(idx);
        }
    }
    if hint.main_visible {
        if let Some(idx) = valid(hint.main_monitor) {
            return Some(idx);
        }
    }
    valid(hint.companion_monitor)
        .or_else(|| valid(hint.main_monitor))
        .or_else(|| valid(hint.primary_monitor))
        .or(Some(0))
}

fn same_monitor(a: &tauri::Monitor, b: &tauri::Monitor) -> bool {
    a.position() == b.position()
        && a.size() == b.size()
        && a.name() == b.name()
        && (a.scale_factor() - b.scale_factor()).abs() < 1e-6
}

fn monitor_bounds(monitor: &tauri::Monitor) -> MonitorBounds {
    #[cfg(target_os = "macos")]
    {
        let scale = if monitor.scale_factor().is_finite() && monitor.scale_factor() > 0.0 {
            monitor.scale_factor()
        } else {
            1.0
        };
        MonitorBounds {
            x: f64::from(monitor.position().x) / scale,
            y: f64::from(monitor.position().y) / scale,
            width: f64::from(monitor.size().width) / scale,
            height: f64::from(monitor.size().height) / scale,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        MonitorBounds {
            x: f64::from(monitor.position().x),
            y: f64::from(monitor.position().y),
            width: f64::from(monitor.size().width),
            height: f64::from(monitor.size().height),
        }
    }
}

fn select_monitor(
    handle: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<tauri::Monitor> {
    let monitors = handle
        .available_monitors()
        .ok()
        .filter(|list| !list.is_empty())
        .or_else(|| window.available_monitors().ok())
        .unwrap_or_default();
    let main_window = handle.get_webview_window("main");
    let main_mon = main_window
        .as_ref()
        .and_then(|main| main.current_monitor().ok().flatten());
    let companion_mon = window.current_monitor().ok().flatten();
    let primary_mon = window.primary_monitor().ok().flatten();

    if monitors.is_empty() {
        return main_mon.or(companion_mon).or(primary_mon);
    }

    let find_index = |target: Option<&tauri::Monitor>| {
        target.and_then(|t| monitors.iter().position(|m| same_monitor(m, t)))
    };

    #[cfg(target_os = "macos")]
    let (frontmost_is_self, frontmost_window, cursor) = {
        let primary_height = primary_mon
            .as_ref()
            .filter(|p| p.scale_factor().is_finite() && p.scale_factor() > 0.0)
            .map(|p| f64::from(p.size().height) / p.scale_factor());
        let signals = crate::companion_macos::active_display_signals(primary_height);
        let frontmost_window = signals.frontmost_window.map(|r| MonitorBounds {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        });
        (signals.frontmost_is_self, frontmost_window, signals.cursor)
    };
    #[cfg(not(target_os = "macos"))]
    let (frontmost_is_self, frontmost_window, cursor) = {
        let cursor = handle.cursor_position().ok().map(|pos| (pos.x, pos.y));
        (false, None, cursor)
    };

    let main_visible = main_window
        .as_ref()
        .and_then(|main| main.is_visible().ok())
        .unwrap_or(false);
    let main_focused = main_window
        .as_ref()
        .and_then(|main| main.is_focused().ok())
        .unwrap_or(false);

    let bounds: Vec<MonitorBounds> = monitors.iter().map(monitor_bounds).collect();
    let hint = ActiveDisplayHint {
        frontmost_is_self,
        frontmost_window,
        cursor,
        main_monitor: find_index(main_mon.as_ref()),
        main_visible,
        main_focused,
        companion_monitor: find_index(companion_mon.as_ref()),
        primary_monitor: find_index(primary_mon.as_ref()),
    };
    select_monitor_index(&bounds, &hint)
        .and_then(|idx| monitors.into_iter().nth(idx))
        .or(main_mon)
        .or(companion_mon)
        .or(primary_mon)
}

#[cfg(target_os = "macos")]
fn show_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    crate::companion_macos::show(window).or_else(|()| window.show())
}

#[cfg(not(target_os = "macos"))]
fn show_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.show()
}

#[cfg(target_os = "macos")]
fn ensure_front(window: &tauri::WebviewWindow) {
    crate::companion_macos::ensure_front(window);
}

#[cfg(not(target_os = "macos"))]
fn ensure_front(_: &tauri::WebviewWindow) {}

/// Moves and resizes the companion as one change on macOS, so no
/// transitional frame exists between them.
#[cfg(target_os = "macos")]
fn set_frame(window: &tauri::WebviewWindow, frame: Frame, scale: f64) -> tauri::Result<()> {
    crate::companion_macos::set_frame(window, (frame.x, frame.y, frame.width, frame.height), scale)
        .or_else(|()| set_frame_in_steps(window, frame))
}

#[cfg(not(target_os = "macos"))]
fn set_frame(window: &tauri::WebviewWindow, frame: Frame, _: f64) -> tauri::Result<()> {
    set_frame_in_steps(window, frame)
}

/// Move before the resize so a window that is about to get wider is never
/// off the display's edge in between, and again after it, because a resize
/// keeps the bottom edge in place.
fn set_frame_in_steps(window: &tauri::WebviewWindow, frame: Frame) -> tauri::Result<()> {
    window
        .set_position(PhysicalPosition::new(frame.x, frame.y))
        .and_then(|_| window.set_size(PhysicalSize::new(frame.width, frame.height)))
        .and_then(|_| window.set_position(PhysicalPosition::new(frame.x, frame.y)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, Response};

    #[test]
    fn a_cue_that_goes_keeps_the_window_until_its_fold_has_played() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let showing = |mode| Placement {
            applied: Some((mode, None)),
            ..Placement::default()
        };

        // The cue goes and the bar is next: wait out the leaving animation.
        let mut placement = showing(Mode::Question);
        assert_eq!(
            placement.leave_wait(Mode::Compact, at(0), false),
            Some(Duration::from_millis(LEAVE_MS))
        );
        assert_eq!(
            placement.leave_wait(Mode::Compact, at(100), false),
            Some(Duration::from_millis(LEAVE_MS - 100))
        );
        assert_eq!(
            placement.leave_wait(Mode::Compact, at(LEAVE_MS), false),
            None
        );
        assert!(placement.leaving.is_none());

        // Reduced motion plays no fold, so the window returns at once.
        let mut placement = showing(Mode::Question);
        assert_eq!(placement.leave_wait(Mode::Compact, at(0), true), None);

        // Hiding the companion, or having had no cue, waits for nothing.
        assert_eq!(
            showing(Mode::Question).leave_wait(Mode::Hidden, at(0), false),
            None
        );
        assert_eq!(
            showing(Mode::Compact).leave_wait(Mode::Compact, at(0), false),
            None
        );
        assert_eq!(
            Placement::default().leave_wait(Mode::Compact, at(0), false),
            None
        );

        // Another cue arriving during the wait cancels it; the next one to
        // go starts a full wait of its own.
        let mut placement = showing(Mode::Question);
        assert!(placement.leave_wait(Mode::Compact, at(0), false).is_some());
        assert_eq!(placement.leave_wait(Mode::Question, at(50), false), None);
        assert_eq!(
            placement.leave_wait(Mode::Compact, at(150), false),
            Some(Duration::from_millis(LEAVE_MS))
        );
    }

    #[test]
    fn a_call_starting_offer_shows_the_companion_with_no_session_unless_it_is_hidden() {
        let mut engine = Engine::default();
        let mut snapshot = engine.cue_snapshot();
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Off),
            Mode::Hidden
        );
        snapshot.call_prompt = Some(crate::call_prompt::Prompt {
            application: Some("Fictional Call".into()),
            kind: Some(crate::call_prompt::Kind::Meeting),
            id: 1,
        });
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Off),
            Mode::Prompt
        );
        let compact = frame(
            (0, 0),
            (1600, 1000),
            1.0,
            Mode::Prompt,
            CompanionPosition::BottomRight,
            QuestionSize::Standard,
        );
        let large = frame(
            (0, 0),
            (1600, 1000),
            1.0,
            Mode::Prompt,
            CompanionPosition::BottomRight,
            QuestionSize::Large,
        );
        assert_eq!((compact.width, compact.height), (320, 160));
        assert_eq!((large.width, large.height), (320, 204));
        // The person hid the companion: the offer does not bring it back.
        engine.set_overlay(false);
        let mut hidden = engine.cue_snapshot();
        hidden.call_prompt = snapshot.call_prompt.clone();
        assert_eq!(
            Mode::for_snapshot(&hidden, MicrophoneStatus::Off),
            Mode::Hidden
        );
    }

    #[test]
    fn a_calendar_prompt_shows_the_companion_with_no_session_unless_it_is_hidden() {
        let mut engine = Engine::default();
        let mut snapshot = engine.cue_snapshot();
        snapshot.calendar_prompt = Some(crate::calendar::Prompt {
            id: 1,
            title: "Weekly Design Sync".into(),
            minutes_until_start: 2,
        });
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Off),
            Mode::Question
        );
        engine.set_overlay(false);
        let mut hidden = engine.cue_snapshot();
        hidden.calendar_prompt = snapshot.calendar_prompt.clone();
        assert_eq!(
            Mode::for_snapshot(&hidden, MicrophoneStatus::Off),
            Mode::Hidden
        );
    }

    #[test]
    fn a_call_end_prompt_keeps_the_companion_open_unless_hidden() {
        let mut engine = Engine::live();
        engine.start().unwrap();
        let mut snapshot = engine.cue_snapshot();
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Listening),
            Mode::Compact
        );
        snapshot.call_end_prompt = Some(crate::call_prompt::CallEndPrompt { id: 1 });
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Listening),
            Mode::Question
        );
        snapshot.overlay_enabled = false;
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Listening),
            Mode::Hidden
        );
    }

    #[test]
    fn an_end_prompt_keeps_the_companion_open_unless_hidden() {
        let mut engine = Engine::live();
        engine.start().unwrap();
        engine.end();
        let mut snapshot = engine.cue_snapshot();
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Off),
            Mode::Hidden
        );
        snapshot.end_prompt = Some(crate::engine::EndPrompt {
            session: 1,
            state: crate::engine::EndPromptState::Saved,
            transcript_lines: 3,
            has_notes: true,
            error: None,
        });
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Off),
            Mode::Question
        );
        snapshot.overlay_enabled = false;
        assert_eq!(
            Mode::for_snapshot(&snapshot, MicrophoneStatus::Off),
            Mode::Hidden
        );
    }

    #[test]
    fn companion_follows_session_and_question_lifecycle() {
        let mut engine = Engine::fictional();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
        engine.start().unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Compact
        );
        engine.advance(8_200);
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Question
        );
        engine.pause().unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Question
        );
        engine.resume().unwrap();
        let id = engine.state.cue.as_ref().unwrap().id.clone();
        engine.respond(&id, Response::Dismiss).unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Compact
        );
        engine.set_overlay(false);
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
        engine.set_overlay(true);
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Compact
        );
        engine.end();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
    }

    #[test]
    fn a_cue_keeps_the_bars_width_on_every_display() {
        let width = |area: (u32, u32), scale: f64, mode| {
            frame(
                (0, 0),
                area,
                scale,
                mode,
                CompanionPosition::BottomRight,
                QuestionSize::Standard,
            )
            .width
        };
        // One width on every display: the bar's, in physical pixels.
        assert_eq!(width((1024, 768), 1.0, Mode::Question), 320);
        assert_eq!(width((2880, 1800), 2.0, Mode::Question), 640);
        assert_eq!(width((2560, 1440), 1.0, Mode::Question), 320);
        assert_eq!(width((5120, 2880), 2.0, Mode::Question), 640);
        assert_eq!(width((1708, 960), 1.25, Mode::Question), 400);
        assert_eq!(width((2560, 1440), 1.0, Mode::Compact), 320);
        // Nothing exceeds the display.
        assert_eq!(width((300, 200), 1.0, Mode::Question), 260);
    }

    #[test]
    fn the_bar_sits_on_the_edge_that_stays_put_when_a_cue_grows() {
        // The default preset grows upward from its bottom edge.
        assert!(anchored_at_bottom(CompanionPosition::BottomRight, None));
        // Top presets, and any window the person dragged, keep their top.
        for position in [
            CompanionPosition::TopLeft,
            CompanionPosition::TopCenter,
            CompanionPosition::TopRight,
        ] {
            assert!(!anchored_at_bottom(position, None));
        }
        assert!(!anchored_at_bottom(
            CompanionPosition::BottomRight,
            Some((300, 200))
        ));
        // The page reads the same answer when it loads.
        assert_eq!(edge(CompanionPosition::BottomRight, None), "bottom");
        assert_eq!(edge(CompanionPosition::TopRight, None), "top");
        assert_eq!(
            edge(CompanionPosition::BottomRight, Some((300, 200))),
            "top"
        );
        // And the frames agree: bottom right keeps the bar's bottom edge,
        // a dragged window its top edge.
        let at = |mode, dragged| {
            frame_at(
                (0, 0),
                (1600, 1000),
                1.0,
                mode,
                CompanionPosition::BottomRight,
                QuestionSize::Standard,
                dragged,
            )
        };
        let (bar, cue) = (at(Mode::Compact, None), at(Mode::Question, None));
        assert_eq!(bar.y + bar.height as i32, cue.y + cue.height as i32);
        let dragged = Some((300, 200));
        assert_eq!(at(Mode::Compact, dragged).y, at(Mode::Question, dragged).y);
    }

    #[test]
    fn a_dragged_position_is_kept_and_pulled_back_inside_the_display() {
        let at = |mode, dragged| {
            frame_at(
                (0, 0),
                (1600, 1000),
                1.0,
                mode,
                CompanionPosition::BottomRight,
                QuestionSize::Standard,
                dragged,
            )
        };
        // Where the person put it, not the preset corner.
        let moved = at(Mode::Question, Some((300, 200)));
        assert_eq!((moved.x, moved.y), (300, 200));
        assert_ne!((moved.x, moved.y), {
            let preset = at(Mode::Question, None);
            (preset.x, preset.y)
        });
        // A cue arriving near the bottom edge moves it up, not off.
        let grown = at(Mode::Question, Some((300, 850)));
        assert_eq!(grown.y + grown.height as i32, 1000);
        assert_eq!(grown.x, 300);
        // A position past the right edge, or above the top, is pulled in.
        let far = at(Mode::Compact, Some((2000, -50)));
        assert_eq!(far.x + far.width as i32, 1600);
        assert_eq!(far.y, 0);
        // A display left of the primary keeps negative coordinates.
        let left = frame_at(
            (-1600, -900),
            (1600, 860),
            1.0,
            Mode::Question,
            CompanionPosition::TopLeft,
            QuestionSize::Standard,
            Some((-1700, -950)),
        );
        assert_eq!((left.x, left.y), (-1600, -900));
    }

    #[test]
    fn only_a_move_the_app_did_not_ask_for_counts_as_a_drag() {
        let start = Instant::now();
        let frame = Frame {
            x: 1160,
            y: 640,
            width: 420,
            height: 340,
        };
        let mut placement = Placement {
            applied: Some((Mode::Question, Some(frame))),
            dragged: None,
            expected: Some(((1160, 640), start)),
            leaving: None,
        };
        // A resize moves the corner first; then the move lands. Neither is a drag.
        assert!(!placement.note_move((1160, 904), start));
        assert!(!placement.note_move((1160, 640), start + Duration::from_millis(5)));
        assert_eq!(placement.dragged, None);
        // Now the person drags it.
        assert!(placement.note_move((300, 200), start + Duration::from_millis(10)));
        assert_eq!(placement.dragged, Some((300, 200)));
        assert_eq!(placement.applied, None, "reapplied on the next refresh");
        // A move the system refused does not swallow later drags for ever.
        placement.expected = Some(((0, 0), start));
        assert!(!placement.note_move((50, 50), start + Duration::from_millis(500)));
        assert!(placement.note_move((60, 60), start + Duration::from_millis(1_500)));
        assert_eq!(placement.dragged, Some((60, 60)));
        // The window reporting the frame it already has is not a drag.
        placement.applied = Some((Mode::Question, Some(frame)));
        placement.expected = None;
        assert!(!placement.note_move((1160, 640), start + Duration::from_millis(2_000)));
    }

    #[test]
    fn a_held_or_answered_question_keeps_the_window_at_one_size() {
        let mut engine = Engine::fictional();
        engine.start().unwrap();
        engine.advance(37_000);
        let id = engine.state.cue.as_ref().unwrap().id.clone();
        let mode =
            |engine: &Engine| Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off);
        assert_eq!(mode(&engine), Mode::Question);
        engine.inspect_cue(&id).unwrap();
        assert_eq!(mode(&engine), Mode::Question);
        engine.advance(14_000); // The scenario agrees on Friday at 51 s.
        assert!(engine.state.cue.as_ref().unwrap().resolved_by.is_some());
        assert_eq!(mode(&engine), Mode::Question);
        let height = |size| {
            frame(
                (0, 0),
                (1600, 1000),
                1.0,
                Mode::Question,
                CompanionPosition::BottomRight,
                size,
            )
            .height
        };
        // One height for a cue; large text adds 44 px.
        assert_eq!(height(QuestionSize::Standard), 232);
        assert_eq!(height(QuestionSize::Large), 276);
    }

    #[test]
    fn microphone_keeps_companion_available_without_a_session_and_respects_hide() {
        let mut engine = Engine::fictional();
        for status in [
            MicrophoneStatus::Starting,
            MicrophoneStatus::Listening,
            MicrophoneStatus::Stopping,
            MicrophoneStatus::Error,
        ] {
            assert_eq!(
                Mode::for_snapshot(&engine.cue_snapshot(), status),
                Mode::Compact
            );
            engine.start().unwrap();
            engine.advance(8_200);
            assert_eq!(
                Mode::for_snapshot(&engine.cue_snapshot(), status),
                Mode::Question
            );
            engine.pause().unwrap();
            assert_eq!(
                Mode::for_snapshot(&engine.cue_snapshot(), status),
                Mode::Question
            );
            engine.end();
            assert_eq!(
                Mode::for_snapshot(&engine.cue_snapshot(), status),
                Mode::Compact
            );
            engine.set_overlay(false);
            assert_eq!(
                Mode::for_snapshot(&engine.cue_snapshot(), status),
                Mode::Hidden
            );
            engine.set_overlay(true);
        }
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
    }

    #[test]
    fn expands_upward_above_the_dock_on_scaled_negative_origin_display() {
        let compact = frame(
            (-2560, 50),
            (2560, 1330),
            2.0,
            Mode::Compact,
            CompanionPosition::BottomRight,
            QuestionSize::Standard,
        );
        let question = frame(
            (-2560, 50),
            (2560, 1330),
            2.0,
            Mode::Question,
            CompanionPosition::BottomRight,
            QuestionSize::Standard,
        );
        assert_eq!(compact.x, -680);
        assert_eq!(compact.y, 1188);
        assert_eq!(question.width, compact.width);
        assert!(question.height > compact.height);
        assert_eq!(
            question.x + question.width as i32,
            compact.x + compact.width as i32
        );
        assert_eq!(
            question.y + question.height as i32,
            compact.y + compact.height as i32
        );
        assert_eq!(question.y + question.height as i32, 1340);
    }

    #[test]
    fn stays_inside_small_work_areas() {
        for (width, height) in [(320, 240), (1, 1), (1280, 720)] {
            for scale in [1.0, 1.5, 2.0] {
                let result = frame(
                    (40, -200),
                    (width, height),
                    scale,
                    Mode::Question,
                    CompanionPosition::BottomRight,
                    QuestionSize::Standard,
                );
                assert!(result.x >= 40 && result.y >= -200);
                assert!(result.x as i64 + i64::from(result.width) <= 40 + i64::from(width));
                assert!(result.y as i64 + i64::from(result.height) <= -200 + i64::from(height));
            }
        }
    }

    #[test]
    fn top_placements_keep_their_anchor_when_the_text_is_larger() {
        for position in [
            CompanionPosition::TopLeft,
            CompanionPosition::TopCenter,
            CompanionPosition::TopRight,
        ] {
            let question = frame(
                (-1600, -900),
                (1600, 860),
                1.0,
                Mode::Question,
                position,
                QuestionSize::Standard,
            );
            let large = frame(
                (-1600, -900),
                (1600, 860),
                1.0,
                Mode::Question,
                position,
                QuestionSize::Large,
            );
            assert_eq!(question.y, -880);
            assert_eq!(large.y, question.y);
            assert_eq!(large.x, question.x);
            assert!(large.height > question.height);
            if position == CompanionPosition::TopCenter {
                assert_eq!(question.x + question.width as i32 / 2, -800);
            }
        }
    }

    #[test]
    fn every_placement_clamps_a_large_text_cue_to_small_or_scaled_work_areas() {
        for position in [
            CompanionPosition::BottomRight,
            CompanionPosition::TopCenter,
            CompanionPosition::TopLeft,
            CompanionPosition::TopRight,
        ] {
            for area in [(1, 1), (280, 240), (1440, 850)] {
                for scale in [1.0, 2.0] {
                    let f = frame(
                        (-500, 40),
                        area,
                        scale,
                        Mode::Question,
                        position,
                        QuestionSize::Large,
                    );
                    assert!(f.x >= -500 && f.y >= 40);
                    assert!(i64::from(f.x) + i64::from(f.width) <= -500 + i64::from(area.0));
                    assert!(i64::from(f.y) + i64::from(f.height) <= 40 + i64::from(area.1));
                }
            }
        }
    }

    #[test]
    fn a_held_cue_stays_visible_after_playback_finishes() {
        let mut engine = Engine::fictional();
        engine.start().unwrap();
        engine.advance(8_000);
        engine.inspect_cue("1:s2").unwrap();
        engine.advance(200_000);
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Question
        );
        engine.respond("1:s2", Response::Dismiss).unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
    }

    fn display(x: f64, y: f64, width: f64, height: f64) -> MonitorBounds {
        MonitorBounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn active_display_prefers_frontmost_call_window_over_notebook_display() {
        let builtin = display(0.0, 0.0, 1512.0, 982.0);
        let external = display(1512.0, 0.0, 1920.0, 1080.0);
        let monitors = [builtin, external];

        // Notebook is visible on the built-in display while a browser call runs
        // in the foreground on the external display; even with the pointer left
        // on the built-in display, the companion anchors to the call display.
        let hint = ActiveDisplayHint {
            frontmost_is_self: false,
            frontmost_window: Some(display(1560.0, 40.0, 1400.0, 900.0)),
            cursor: Some((400.0, 500.0)),
            main_monitor: Some(0),
            main_visible: true,
            main_focused: false,
            companion_monitor: Some(0),
            primary_monitor: Some(0),
        };
        assert_eq!(select_monitor_index(&monitors, &hint), Some(1));
    }

    #[test]
    fn active_display_picks_largest_overlap_and_negative_coordinate_displays() {
        let left = display(-2560.0, 0.0, 2560.0, 1440.0);
        let center = display(0.0, 0.0, 1512.0, 982.0);
        let above = display(0.0, -1080.0, 1920.0, 1080.0);
        let monitors = [center, left, above];

        // Window mostly on the left external display, slightly straddling center.
        let mostly_left = ActiveDisplayHint {
            frontmost_window: Some(display(-1200.0, 100.0, 1400.0, 800.0)),
            main_monitor: Some(0),
            main_visible: true,
            ..ActiveDisplayHint::default()
        };
        assert_eq!(select_monitor_index(&monitors, &mostly_left), Some(1));

        // Cursor on the upper display when frontmost app has no onscreen window.
        let cursor_above = ActiveDisplayHint {
            cursor: Some((600.0, -400.0)),
            main_monitor: Some(0),
            main_visible: true,
            ..ActiveDisplayHint::default()
        };
        assert_eq!(select_monitor_index(&monitors, &cursor_above), Some(2));
    }

    #[test]
    fn clicking_companion_or_hiding_notebook_keeps_companion_on_cursor_display() {
        let builtin = display(0.0, 0.0, 1512.0, 982.0);
        let external = display(1512.0, 0.0, 1920.0, 1080.0);
        let monitors = [builtin, external];

        // Notebook hidden in the menu bar on display 0; user clicked the
        // companion on display 1 so TalkQTE is briefly frontmost.
        let clicked_while_main_hidden = ActiveDisplayHint {
            frontmost_is_self: true,
            frontmost_window: None,
            cursor: Some((3100.0, 900.0)),
            main_monitor: Some(0),
            main_visible: false,
            main_focused: false,
            companion_monitor: Some(1),
            primary_monitor: Some(0),
        };
        assert_eq!(
            select_monitor_index(&monitors, &clicked_while_main_hidden),
            Some(1)
        );

        // Notebook visible and unfocused on display 0 while user interacts with
        // companion on display 1.
        let clicked_while_main_unfocused = ActiveDisplayHint {
            main_visible: true,
            main_focused: false,
            ..clicked_while_main_hidden
        };
        assert_eq!(
            select_monitor_index(&monitors, &clicked_while_main_unfocused),
            Some(1)
        );

        // User explicitly focused the notebook on display 0.
        let focused_notebook = ActiveDisplayHint {
            main_visible: true,
            main_focused: true,
            ..clicked_while_main_hidden
        };
        assert_eq!(select_monitor_index(&monitors, &focused_notebook), Some(0));
    }

    #[test]
    fn active_display_fallback_order_handles_missing_signals_and_empty_lists() {
        let monitors = [
            display(0.0, 0.0, 1440.0, 900.0),
            display(1440.0, 0.0, 1920.0, 1080.0),
        ];
        assert_eq!(
            select_monitor_index(&[], &ActiveDisplayHint::default()),
            None
        );
        // Visible notebook wins over stale companion/primary if no window/cursor.
        assert_eq!(
            select_monitor_index(
                &monitors,
                &ActiveDisplayHint {
                    main_monitor: Some(1),
                    main_visible: true,
                    companion_monitor: Some(0),
                    primary_monitor: Some(0),
                    ..ActiveDisplayHint::default()
                },
            ),
            Some(1)
        );
        // Hidden notebook falls back to companion, then main, then primary, then 0.
        assert_eq!(
            select_monitor_index(
                &monitors,
                &ActiveDisplayHint {
                    main_monitor: Some(0),
                    main_visible: false,
                    companion_monitor: Some(1),
                    primary_monitor: Some(0),
                    ..ActiveDisplayHint::default()
                },
            ),
            Some(1)
        );
        assert_eq!(
            select_monitor_index(
                &monitors,
                &ActiveDisplayHint {
                    primary_monitor: Some(1),
                    ..ActiveDisplayHint::default()
                },
            ),
            Some(1)
        );
        assert_eq!(
            select_monitor_index(&monitors, &ActiveDisplayHint::default()),
            Some(0)
        );
    }

    #[test]
    fn overlay_defaults_to_enabled_and_visible_modes_never_stay_silently_hidden() {
        let settings = crate::settings::Settings::default();
        assert!(settings.overlay_enabled);
        assert!(crate::settings::parse(b"{}").overlay_enabled);

        let mut engine = Engine::live();
        assert!(engine.cue_snapshot().overlay_enabled);

        // Call-starting offer -> Prompt -> live session -> Compact -> cue -> Hidden.
        let mut offer = engine.cue_snapshot();
        offer.call_prompt = Some(crate::call_prompt::Prompt {
            application: Some("Fictional Browser".into()),
            kind: Some(crate::call_prompt::Kind::Browser),
            id: 7,
        });
        assert_eq!(
            Mode::for_snapshot(&offer, MicrophoneStatus::Off),
            Mode::Prompt
        );

        engine.start().unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Listening),
            Mode::Compact
        );

        let prompt_frame = frame(
            (1512, 0),
            (1920, 1080),
            1.0,
            Mode::Prompt,
            CompanionPosition::BottomRight,
            QuestionSize::Standard,
        );
        // Matching cached state still re-applies if the native window is not visible.
        assert!(should_apply(
            Some((Mode::Prompt, Some(prompt_frame))),
            Mode::Prompt,
            Some(prompt_frame),
            false,
        ));
        assert!(!should_apply(
            Some((Mode::Prompt, Some(prompt_frame))),
            Mode::Prompt,
            Some(prompt_frame),
            true,
        ));
        // Hidden mode does not hide again once already hidden, but does if still visible.
        assert!(!should_apply(
            Some((Mode::Hidden, None)),
            Mode::Hidden,
            None,
            false,
        ));
        assert!(should_apply(
            Some((Mode::Hidden, None)),
            Mode::Hidden,
            None,
            true,
        ));

        engine.end();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
    }
}
