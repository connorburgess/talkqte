//! Native placement stays outside the engine lock. All window queries run on
//! the main thread so a command cannot deadlock while waiting for that thread.
use crate::{
    engine::{CueSnapshot, Status},
    AppState,
};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Hidden,
    Compact,
    Question,
}

impl Mode {
    pub fn for_snapshot(state: &CueSnapshot) -> Self {
        if !state.overlay_enabled || matches!(state.status, Status::Ready | Status::Ended) {
            Self::Hidden
        } else if state.status == Status::Running && state.cue.is_some() {
            Self::Question
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
fn frame(origin: (i32, i32), area: (u32, u32), scale: f64, mode: Mode) -> Frame {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let margin = (20.0 * scale).round() as u32;
    let width = ((380.0 * scale).round() as u32).min(area.0.saturating_sub(2 * margin).max(1));
    let height = ((if mode == Mode::Question { 350.0 } else { 88.0 } * scale).round() as u32)
        .min(area.1.saturating_sub(2 * margin).max(1));
    Frame {
        x: (i64::from(origin.0) + i64::from(area.0.saturating_sub(width + margin)))
            .clamp(i32::MIN.into(), i32::MAX.into()) as i32,
        y: (i64::from(origin.1) + i64::from(area.1.saturating_sub(height + margin)))
            .clamp(i32::MIN.into(), i32::MAX.into()) as i32,
        width,
        height,
    }
}

#[derive(Default)]
pub struct WindowState(Mutex<Option<(Mode, Option<Frame>)>>);

pub fn refresh(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mode = {
            let state = handle.state::<AppState>();
            let Ok(runtime) = state.0.lock() else { return };
            Mode::for_snapshot(&runtime.engine.cue_snapshot())
        }; // Release the engine lock before every native window operation.
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
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Hidden);
        engine.start().unwrap();
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Compact);
        engine.advance(5_200);
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Question);
        engine.pause().unwrap();
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Compact);
        engine.resume().unwrap();
        let id = engine.state.cue.as_ref().unwrap().id.clone();
        engine.respond(&id, Response::Save).unwrap();
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Compact);
        assert_eq!(engine.state.saved.len(), 1);
        engine.set_overlay(false);
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Hidden);
        engine.set_overlay(true);
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Compact);
        engine.end();
        assert_eq!(Mode::for_snapshot(&engine.cue_snapshot()), Mode::Hidden);
    }

    #[test]
    fn expands_upward_above_the_dock_on_scaled_negative_origin_display() {
        let compact = frame((-2560, 50), (2560, 1330), 2.0, Mode::Compact);
        let question = frame((-2560, 50), (2560, 1330), 2.0, Mode::Question);
        assert_eq!(compact.x, -800);
        assert_eq!(compact.y, 1164);
        assert_eq!(question.x, compact.x);
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
                let result = frame((40, -200), (width, height), scale, Mode::Question);
                assert!(result.x >= 40 && result.y >= -200);
                assert!(result.x as i64 + i64::from(result.width) <= 40 + i64::from(width));
                assert!(result.y as i64 + i64::from(result.height) <= -200 + i64::from(height));
            }
        }
    }
}
