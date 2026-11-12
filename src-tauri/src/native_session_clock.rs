//! Private preparation for the disconnected native audio experiment. Snapshot
//! under Runtime, measure on its owning worker, then validate under Runtime.
//! No command calls this yet; it neither starts capture nor grants permission.
#![allow(dead_code)]

use crate::{
    application_audio::{native::ClockBinding, timing::TimingError, Control},
    engine::{StartupState, Status},
    Runtime,
};
use objc2_core_media::{CMClock, CMTime};
use std::time::{Duration, Instant};

pub(crate) struct Snapshot {
    session: u64,
    operation: String,
    control: Control,
    at: Instant,
    elapsed: Duration,
}

pub(crate) struct Measurement {
    snapshot: Snapshot,
    binding: ClockBinding,
    width: Duration,
}

/// The full read bracket, not a device drift estimate or a confidence interval.
/// The host must retain it with its acceptance evidence. This correspondence
/// does not authorize capture or replace ongoing source/session guards.
pub(crate) struct MeasuredBinding {
    pub binding: ClockBinding,
    pub bracket_width: Duration,
}

impl Runtime {
    /// Call with the Runtime mutex held. This method never invokes an SDK.
    pub(crate) fn native_clock_snapshot(
        &mut self,
        control: &Control,
    ) -> Result<Snapshot, TimingError> {
        self.native_clock_snapshot_at(control, Instant::now())
    }

    fn native_clock_snapshot_at(
        &mut self,
        control: &Control,
        now: Instant,
    ) -> Result<Snapshot, TimingError> {
        // Refuse a reversed injected/observed Rust clock instead of letting
        // duration_since saturate it to zero in the ordinary runtime sync.
        now.checked_duration_since(self.last_tick)
            .ok_or(TimingError::Clock)?;
        self.sync_at(now);
        let operation = self.native_clock_operation()?.to_owned();
        if control.is_cancelled() {
            return Err(TimingError::SessionChanged);
        }
        Ok(Snapshot {
            session: self.engine.session(),
            operation,
            control: control.clone(),
            at: self.last_tick,
            elapsed: Duration::from_millis(self.engine.state.elapsed_ms)
                .checked_add(self.tick_remainder)
                .ok_or(TimingError::Overflow)?,
        })
    }

    fn native_clock_operation(&self) -> Result<&str, TimingError> {
        let live = self.live.as_ref().ok_or(TimingError::SessionChanged)?;
        let operation = live
            .operation
            .as_deref()
            .ok_or(TimingError::SessionChanged)?;
        let (current, phase) = self
            .live_start
            .control()
            .map_err(|_| TimingError::SessionChanged)?;
        if !self.engine.state.live
            || self.engine.state.status != Status::Running
            || self.engine.is_live_stopping()
            || live.session != self.engine.session()
            || current.as_deref() != Some(operation)
            || phase == StartupState::Cancelling
        {
            return Err(TimingError::SessionChanged);
        }
        Ok(operation)
    }

    /// Reacquire Runtime after measurement; no native work occurs here. Consume
    /// the measurement once. Stop can still occur after acceptance: the native
    /// owner and every delivered block must keep their existing control checks.
    pub(crate) fn accept_native_clock(
        &self,
        measurement: Measurement,
    ) -> Result<MeasuredBinding, TimingError> {
        let snapshot = &measurement.snapshot;
        if snapshot.session != self.engine.session()
            || self.native_clock_operation()? != snapshot.operation
            || snapshot.control.is_cancelled()
        {
            return Err(TimingError::SessionChanged);
        }
        Ok(MeasuredBinding {
            binding: measurement.binding,
            bracket_width: measurement.width,
        })
    }
}

impl Snapshot {
    /// Call on the native owner worker, with NO Runtime mutex held. One bounded
    /// attempt only; max_width is explicit host policy, not a universal budget.
    pub(crate) fn measure(self, max_width: Duration) -> Result<Measurement, TimingError> {
        self.measure_with(max_width, Instant::now, || {
            // SAFETY: the framework's singleton host clock is valid for this
            // synchronous read. No capture object or borrowed callback is used.
            unsafe { CMClock::host_time_clock().time() }
        })
    }

    fn measure_with(
        self,
        max_width: Duration,
        mut now: impl FnMut() -> Instant,
        read_host: impl FnOnce() -> CMTime,
    ) -> Result<Measurement, TimingError> {
        if self.control.is_cancelled() {
            return Err(TimingError::SessionChanged);
        }
        let before = now();
        let host = read_host();
        let after = now();
        if self.control.is_cancelled() {
            return Err(TimingError::SessionChanged);
        }
        let width = after
            .checked_duration_since(before)
            .ok_or(TimingError::Clock)?;
        if width > max_width {
            return Err(TimingError::Clock);
        }
        let delay = before
            .checked_duration_since(self.at)
            .ok_or(TimingError::Clock)?;
        // Preserve fractional milliseconds and scheduling delay. The host read
        // occurred somewhere in this bracket; the midpoint is only an estimate.
        let midpoint = self
            .elapsed
            .checked_add(delay)
            .and_then(|t| t.checked_add(width / 2))
            .ok_or(TimingError::Overflow)?;
        let binding = ClockBinding::new(self.session, host, midpoint)?;
        Ok(Measurement {
            snapshot: self,
            binding,
            width,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_audio::{Application, Gate, Review};
    use objc2_core_media::CMTimeFlags;

    fn setup() -> (Runtime, Gate, Review, Control) {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
        drop(ticket);
        let gate = Gate::default();
        let review = gate
            .review(Application::new("fictional".into(), "Fictional player".into()).unwrap())
            .unwrap();
        let control = review.control();
        (runtime, gate, review, control)
    }

    fn host() -> CMTime {
        CMTime {
            value: 17,
            timescale: 1,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        }
    }

    fn measured(
        snapshot: Snapshot,
        before: Instant,
        after: Instant,
        max: Duration,
    ) -> Result<Measurement, TimingError> {
        let mut times = [before, after].into_iter();
        snapshot.measure_with(max, || times.next().unwrap(), host)
    }

    #[test]
    fn fractional_snapshot_and_delayed_worker_keep_full_bracket() {
        let (mut runtime, _gate, _review, control) = setup();
        let origin = runtime.last_tick;
        let at = origin + Duration::from_micros(1_750);
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        assert_eq!(snapshot.elapsed, Duration::from_micros(1_750));
        let before = at + Duration::from_micros(10_000);
        let measurement = measured(
            snapshot,
            before,
            before + Duration::from_nanos(501),
            Duration::from_nanos(501),
        )
        .unwrap();
        // Check the actual binding by mapping its host origin through the same
        // rational conversion used by native delivery, without a native stream.
        assert_eq!(measurement.binding.session_ms_for_test(host()).unwrap(), 11);
        assert_eq!(
            measurement.binding.session_time_for_test(),
            Duration::from_nanos(11_750_250)
        );
        runtime.sync_at(before + Duration::from_millis(1));
        let accepted = runtime.accept_native_clock(measurement).unwrap();
        assert_eq!(accepted.bracket_width, Duration::from_nanos(501));
    }

    #[test]
    fn invalid_brackets_and_clock_values_never_produce_a_binding() {
        for case in 0..6 {
            let (mut runtime, _gate, _review, control) = setup();
            let at = runtime.last_tick;
            let mut snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
            let (before, after) = match case {
                0 => (at, at + Duration::from_millis(2)),
                1 => (at + Duration::from_millis(1), at),
                2 => (at - Duration::from_millis(1), at),
                _ => (at, at + Duration::from_micros(1)),
            };
            if case == 3 {
                snapshot.elapsed = Duration::MAX;
            }
            let mut times = [before, after].into_iter();
            let result = snapshot.measure_with(
                Duration::from_millis(1),
                || times.next().unwrap(),
                || {
                    let mut value = host();
                    if case == 4 {
                        value.flags = CMTimeFlags::empty();
                    }
                    if case == 5 {
                        value.value = -1;
                    }
                    value
                },
            );
            assert!(result.is_err(), "case {case}");
        }
    }

    #[test]
    fn stop_or_replacement_during_read_or_before_acceptance_rejects_measurement() {
        for case in 0..5 {
            let (mut runtime, gate, _review, control) = setup();
            let at = runtime.last_tick;
            let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
            let measurement = snapshot.measure_with(
                Duration::ZERO,
                || at,
                || {
                    match case {
                        0 => {
                            runtime.take_live_for_stop();
                        }
                        1 => {
                            gate.stop(&control).unwrap();
                        }
                        2 => {
                            runtime.take_live_for_stop();
                            runtime.engine.end();
                            let ticket = runtime.begin_live_start().unwrap();
                            runtime.install_live_start(&ticket).unwrap();
                        }
                        _ => {}
                    }
                    host()
                },
            );
            if case == 1 {
                assert!(matches!(measurement, Err(TimingError::SessionChanged)));
                continue;
            }
            if case == 3 {
                runtime.engine.begin_live_stop();
            }
            if case == 4 {
                gate.stop(&control).unwrap();
            }
            assert!(matches!(
                runtime.accept_native_clock(measurement.unwrap()),
                Err(TimingError::SessionChanged)
            ));
        }
    }

    #[test]
    fn cancelled_source_skips_native_read_and_reversed_snapshot_is_rejected() {
        let (mut runtime, gate, _review, control) = setup();
        let at = runtime.last_tick;
        assert!(matches!(
            runtime.native_clock_snapshot_at(&control, at - Duration::from_nanos(1)),
            Err(TimingError::Clock)
        ));
        let snapshot = runtime.native_clock_snapshot_at(&control, at).unwrap();
        gate.stop(&control).unwrap();
        assert!(matches!(
            snapshot.measure_with(Duration::ZERO, || at, || panic!("cancelled read")),
            Err(TimingError::SessionChanged)
        ));
        assert!(runtime.native_clock_snapshot_at(&control, at).is_err());
    }

    #[test]
    fn demo_ended_stopping_and_wrong_operation_refused_but_cue_pause_runs() {
        for case in 0..6 {
            let (mut runtime, _gate, _review, control) = setup();
            let at = runtime.last_tick;
            match case {
                0 => {
                    runtime.engine = crate::Engine::default();
                    runtime.engine.start().unwrap();
                }
                1 => runtime.engine.end(),
                2 => runtime.engine.begin_live_stop(),
                3 => runtime.live.as_mut().unwrap().operation = Some("different".into()),
                4 => runtime.live.as_mut().unwrap().session += 1,
                _ => runtime.engine.set_live_cues_paused(true).unwrap(),
            }
            let snapshot =
                runtime.native_clock_snapshot_at(&control, at + Duration::from_micros(750));
            if case == 5 {
                let snapshot = snapshot.unwrap();
                assert_eq!(snapshot.elapsed, Duration::from_micros(750));
                let measurement = measured(
                    snapshot,
                    at + Duration::from_millis(1),
                    at + Duration::from_millis(1),
                    Duration::ZERO,
                )
                .unwrap();
                assert!(runtime.accept_native_clock(measurement).is_ok());
            } else {
                assert!(
                    matches!(snapshot, Err(TimingError::SessionChanged)),
                    "case {case}"
                );
            }
        }
    }
}
