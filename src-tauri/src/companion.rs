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
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Hidden,
    Compact,
    Question,
    Details,
    /// Context plus the later line that answered the question.
    AnsweredDetails,
}

impl Mode {
    pub fn for_snapshot(state: &CueSnapshot, microphone: MicrophoneStatus) -> Self {
        if !state.overlay_enabled {
            Self::Hidden
        } else if let Some(cue) = &state.cue {
            if cue.expanded && cue.resolved_by.is_some() {
                Self::AnsweredDetails
            } else if cue.expanded {
                Self::Details
            } else {
                Self::Question
            }
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

/// The compact bar's width in logical pixels.
const COMPACT_WIDTH: f64 = 320.0;

/// The question window's width in logical pixels for a display of this
/// logical width. A glance window stays narrow: about 30 to 40 characters a
/// line at the standard 24 px question size, well inside the 80-character
/// line WCAG 2.2 SC 1.4.8 treats as the upper bound. A small laptop display
/// gives up 60 px so the window covers less of the meeting; a large display
/// gains 60 px so a question wraps to fewer lines.
fn question_width(display_width: f64) -> f64 {
    if display_width <= 1100.0 {
        360.0
    } else if display_width >= 2400.0 {
        480.0
    } else {
        420.0
    }
}

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
    let question = matches!(mode, Mode::Question | Mode::Details | Mode::AnsweredDetails);
    let logical_width = if question {
        question_width(f64::from(area.0) / scale)
    } else {
        COMPACT_WIDTH
    };
    let width =
        ((logical_width * scale).round() as u32).min(area.0.saturating_sub(2 * margin).max(1));
    let logical_height = match mode {
        Mode::Question => 340.0,
        Mode::Details => 460.0,
        Mode::AnsweredDetails => 560.0,
        _ => 76.0,
    } + if question && text_size == QuestionSize::Large {
        60.0
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
}

/// How long the app's own move may take to land.
const SETTLE_MS: u64 = 1_000;

#[derive(Default)]
pub struct WindowState(Mutex<Placement>);

impl Placement {
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

pub fn refresh(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let cue = {
            let state = handle.state::<AppState>();
            let Ok(runtime) = state.0.lock() else { return };
            runtime.engine.cue_snapshot()
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
        let layout = if mode == Mode::Hidden {
            None
        } else {
            // Follow the notebook's display, falling back after a display disconnect.
            let monitor = handle
                .get_webview_window("main")
                .and_then(|main| main.current_monitor().ok().flatten())
                .or_else(|| window.primary_monitor().ok().flatten());
            let Some(monitor) = monitor else { return };
            let area = monitor.work_area();
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
        if placement.applied == Some((mode, layout)) {
            return;
        }
        placement.expected = layout.map(|frame| ((frame.x, frame.y), Instant::now()));
        let result = if let Some(frame) = layout {
            window
                .set_size(PhysicalSize::new(frame.width, frame.height))
                .and_then(|_| window.set_position(PhysicalPosition::new(frame.x, frame.y)))
                .and_then(|_| window.show())
        } else {
            window.hide()
        };
        if result.is_ok() {
            placement.applied = Some((mode, layout));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, Response};

    #[test]
    fn companion_follows_session_and_question_lifecycle() {
        let mut engine = Engine::default();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Hidden
        );
        engine.start().unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Compact
        );
        engine.advance(5_200);
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
    fn the_question_window_width_follows_the_display() {
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
        // A small laptop (1024 logical px), a 13-inch Mac at 2x (1440
        // logical), a 27-inch display at 1x, and a 5K display at 2x.
        assert_eq!(width((1024, 768), 1.0, Mode::Question), 360);
        assert_eq!(width((2880, 1800), 2.0, Mode::Question), 840);
        assert_eq!(width((2560, 1440), 1.0, Mode::Question), 480);
        assert_eq!(width((5120, 2880), 2.0, Mode::Details), 960);
        // The compact bar does not change, and nothing exceeds the display.
        assert_eq!(width((2560, 1440), 1.0, Mode::Compact), 320);
        assert_eq!(width((300, 200), 1.0, Mode::Question), 260);
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
        // Growing for context near the bottom edge moves it up, not off.
        let grown = at(Mode::Details, Some((300, 700)));
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
    fn an_answered_question_being_read_gets_room_for_the_answer() {
        let mut engine = Engine::default();
        engine.start().unwrap();
        engine.advance(37_000);
        let id = engine.state.cue.as_ref().unwrap().id.clone();
        engine.inspect_cue(&id, true).unwrap();
        engine.advance(14_000); // The demo agrees on Friday at 51 s.
        let mode = Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off);
        assert_eq!(mode, Mode::AnsweredDetails);
        let at = |mode, size| {
            frame(
                (0, 0),
                (1600, 1000),
                1.0,
                mode,
                CompanionPosition::BottomRight,
                size,
            )
        };
        // One question's height, 120 px more for its context, 100 px more
        // for an answer; large text adds 60 px to each.
        assert_eq!(at(Mode::Question, QuestionSize::Standard).height, 340);
        assert_eq!(at(Mode::Details, QuestionSize::Standard).height, 460);
        assert_eq!(at(Mode::AnsweredDetails, QuestionSize::Large).height, 620);
        for size in [QuestionSize::Standard, QuestionSize::Large] {
            assert!(at(Mode::AnsweredDetails, size).height > at(Mode::Details, size).height);
            assert_eq!(
                at(Mode::AnsweredDetails, size).width,
                at(Mode::Details, size).width
            );
        }
        engine.inspect_cue(&id, false).unwrap();
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Question
        );
    }

    #[test]
    fn microphone_keeps_companion_available_without_demo_and_respects_hide() {
        let mut engine = Engine::default();
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
            engine.advance(5_200);
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
        assert!(question.width > compact.width);
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
    fn top_placements_keep_their_anchor_when_context_opens() {
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
            let details = frame(
                (-1600, -900),
                (1600, 860),
                1.0,
                Mode::Details,
                position,
                QuestionSize::Large,
            );
            assert_eq!(question.y, -880);
            assert_eq!(details.y, question.y);
            assert_eq!(details.x, question.x);
            assert!(details.height > question.height);
            if position == CompanionPosition::TopCenter {
                assert_eq!(question.x + question.width as i32 / 2, -800);
            }
        }
    }

    #[test]
    fn every_placement_clamps_large_context_to_small_or_scaled_work_areas() {
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
                        Mode::Details,
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
    fn reading_mode_stays_visible_after_playback_finishes() {
        let mut engine = Engine::default();
        engine.start().unwrap();
        engine.advance(5_000);
        engine.inspect_cue("1:s2", true).unwrap();
        engine.advance(200_000);
        assert_eq!(
            Mode::for_snapshot(&engine.cue_snapshot(), MicrophoneStatus::Off),
            Mode::Details
        );
        engine.inspect_cue("1:s2", false).unwrap();
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
}
