//! Native placement stays outside the engine lock. All window queries run on
//! the main thread so a command cannot deadlock while waiting for that thread.
use crate::{
    engine::{CompanionPosition, CueSnapshot, QuestionSize, Status},
    microphone::{Controller as Microphone, Status as MicrophoneStatus},
    AppState,
};
use std::sync::Mutex;
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
fn frame(
    origin: (i32, i32),
    area: (u32, u32),
    scale: f64,
    mode: Mode,
    position: CompanionPosition,
    text_size: QuestionSize,
) -> Frame {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let margin = (20.0 * scale).round() as u32;
    let question = matches!(mode, Mode::Question | Mode::Details | Mode::AnsweredDetails);
    let width = ((if question { 420.0 } else { 320.0 } * scale).round() as u32)
        .min(area.0.saturating_sub(2 * margin).max(1));
    let logical_height = match mode {
        Mode::Question => 300.0,
        Mode::Details => 420.0,
        Mode::AnsweredDetails => 520.0,
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
    Frame {
        x: (i64::from(origin.0) + i64::from(x)).clamp(i32::MIN.into(), i32::MAX.into()) as i32,
        y: (i64::from(origin.1) + i64::from(y)).clamp(i32::MIN.into(), i32::MAX.into()) as i32,
        width,
        height,
    }
}

#[derive(Default)]
pub struct WindowState(Mutex<Option<(Mode, Option<Frame>)>>);

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
            Some(frame(
                (area.position.x, area.position.y),
                (area.size.width, area.size.height),
                monitor.scale_factor(),
                mode,
                cue.companion_position,
                cue.question_size,
            ))
        };
        let state = handle.state::<WindowState>();
        let Ok(mut applied) = state.0.lock() else {
            return;
        };
        if *applied == Some((mode, layout)) {
            return;
        }
        let result = if let Some(frame) = layout {
            window
                .set_size(PhysicalSize::new(frame.width, frame.height))
                .and_then(|_| window.set_position(PhysicalPosition::new(frame.x, frame.y)))
                .and_then(|_| window.show())
        } else {
            window.hide()
        };
        if result.is_ok() {
            *applied = Some((mode, layout));
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
