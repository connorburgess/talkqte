//! Ties one reviewed application-audio source to the live session it feeds.
//! Stopping or replacing that session cancels the source's operation under the
//! runtime lock with one atomic store: no native call and no wait on a worker,
//! callback or the review gate. The source's owner observes the cancellation
//! and cleans up on its own worker. Nothing here starts capture; only the
//! development host attaches a source. Attachment is not enforced by the audio types:
//! a caller that binds a reader to a session without attaching is not covered.

use crate::{
    application_audio::Control,
    engine::{StartupState, Status},
    Runtime,
};

/// A live session started for one source alone, with that source's control,
/// so the session's Stop also stops a source that has not attached yet.
/// Only a development build or a test starts one.
#[cfg_attr(
    not(any(all(target_os = "macos", feature = "native-audio-spike"), test)),
    allow(dead_code)
)]
pub(crate) struct SourceSession {
    session: u64,
    control: Control,
}

/// Held by the runtime while the source may feed the session. Dropping it,
/// for any reason, cancels the source: an unattached source must not deliver.
pub(crate) struct LiveSource {
    session: u64,
    operation: String,
    control: Control,
}

impl Drop for LiveSource {
    fn drop(&mut self) {
        self.control.cancel();
    }
}

#[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    /// No running live session, the session is stopping, or the source was
    /// already cancelled.
    SessionChanged,
    /// Another source that is still current already feeds this session. It is
    /// left untouched; attaching never replaces a running source.
    Occupied,
}

/// Why the source sink did not take a line.
#[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LineRefused {
    /// The source is not attached to this running session. Its worker should
    /// stop capturing and recognizing: no later line can be accepted either.
    NotAttached,
    /// The engine refused this line, for example as out of order.
    Engine(String),
}

impl Runtime {
    /// The startup operation of the live session a source may feed now. Idle,
    /// ended, stopping and mismatched states have none.
    pub(crate) fn live_source_operation(&self) -> Option<&str> {
        let live = self.live.as_ref()?;
        let operation = live.operation.as_deref()?;
        let (current, phase) = self.live_start.control().ok()?;
        (self.engine.state.live
            && self.engine.state.status == Status::Running
            && !self.engine.is_live_stopping()
            && live.session == self.engine.session()
            && current.as_deref() == Some(operation)
            && phase != StartupState::Cancelling)
            .then_some(operation)
    }

    /// Call with the runtime lock held, before the source may deliver audio
    /// stamped with this session. One source at a time, attached once: a
    /// second attach for the same operation is refused like any other. The
    /// control only has to be uncancelled; a review that is never approved
    /// can occupy the session until it is dropped, and delivers nothing.
    #[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
    pub(crate) fn attach_live_source(&mut self, control: &Control) -> Result<(), Refused> {
        self.reconcile_live_source();
        let operation = self
            .live_source_operation()
            .ok_or(Refused::SessionChanged)?
            .to_owned();
        if control.is_cancelled() {
            return Err(Refused::SessionChanged);
        }
        if self.live_source.is_some() {
            return Err(Refused::Occupied);
        }
        self.live_source = Some(LiveSource {
            session: self.engine.session(),
            operation,
            control: control.clone(),
        });
        Ok(())
    }

    /// Cancel the attached source, if any. Queued and already returned audio
    /// fails its source check from here on; it is discarded, not flushed.
    pub(crate) fn retire_live_source(&mut self) {
        self.live_source = None;
        // A source-only session's source stops with the session, even before
        // it has attached. The session itself ends through the Stop path.
        if let Some(own) = &self.source_session {
            own.control.cancel();
        }
    }

    /// The transcript sink for application audio: the one place a recognized
    /// line from a source enters the engine. Call with the runtime lock held.
    /// A line is refused unless that exact source is attached to this running
    /// session, so audio that reached a worker some other way adds nothing.
    #[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
    pub(crate) fn ingest_source_line(
        &mut self,
        session: u64,
        control: &Control,
        segment: crate::engine::Segment,
    ) -> Result<(), LineRefused> {
        self.sync();
        if !self.live_source_accepts(session, control) {
            return Err(LineRefused::NotAttached);
        }
        self.ingest_timed(session, segment)
            .map_err(LineRefused::Engine)
    }

    /// With the runtime lock held, immediately before a line from this source
    /// is committed. A worker's own source check can pass just before Stop
    /// takes this lock; this one cannot, and it also refuses a source that
    /// was never attached.
    #[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
    pub(crate) fn live_source_accepts(&self, session: u64, control: &Control) -> bool {
        self.live_source.as_ref().is_some_and(|source| {
            source.session == session
                && session == self.engine.session()
                && source.control.same_operation(control)
                && !control.is_cancelled()
                && self.live_source_operation() == Some(source.operation.as_str())
        })
    }

    /// Runs on every runtime sync. A session that ended or was replaced
    /// without passing through Stop still retires its source, and a source
    /// that stopped by itself frees the session for an explicit new one.
    pub(crate) fn reconcile_live_source(&mut self) {
        // A session for an application alone whose source was stopped before
        // it attached has nothing left to wait for. End it now, as when an
        // attached source stops, rather than when the worker's run returns.
        let unattached_and_stopped = self
            .source_session
            .as_ref()
            .filter(|own| own.control.is_cancelled() && self.live_source.is_none())
            .map(|own| own.session);
        if let Some(session) = unattached_and_stopped {
            self.end_source_session(session);
        }
        let Some(source) = &self.live_source else {
            return;
        };
        if source.control.is_cancelled()
            || source.session != self.engine.session()
            || self.live_source_operation() != Some(source.operation.as_str())
        {
            let session = source.session;
            self.live_source = None;
            // A session that only this source fed has nothing left to hear.
            self.end_source_session(session);
        }
    }

    /// The companion's snapshot: the engine's, plus whether the running
    /// session is fed by an application alone, so it never reads a bare Off
    /// for a session whose microphone was never used.
    pub(crate) fn cue_snapshot(&self) -> crate::engine::CueSnapshot {
        let mut snapshot = self.engine.cue_snapshot();
        snapshot.source_session = self.source_session_running();
        snapshot
    }

    /// A session for an application alone is running and its source has not
    /// been stopped.
    pub(crate) fn source_session_running(&self) -> bool {
        self.source_session.as_ref().is_some_and(|own| {
            !own.control.is_cancelled()
                && self.live_session() == Some(own.session)
                && self.engine.session() == own.session
                && self.engine.state.status == Status::Running
                && !self.engine.is_live_stopping()
        })
    }

    /// Whether a standalone microphone check may start now. Not while any
    /// live session runs: a session for an application alone says the
    /// microphone is not used, and its Stop would not release a check that
    /// started inside it.
    pub(crate) fn microphone_may_start(&self) -> bool {
        #[cfg(all(
            debug_assertions,
            target_os = "macos",
            feature = "native-audio-spike",
            feature = "lab-evaluator"
        ))]
        if crate::dev_stop::source_only() {
            return false;
        }
        self.live.is_none()
    }

    fn live_session(&self) -> Option<u64> {
        self.live.as_ref().map(|live| live.session)
    }

    /// Start a live session that only an application source will feed. No
    /// model is loaded and no microphone is opened here; the source's worker
    /// loads its own recognizer. Refused while any session runs, as an
    /// ordinary live start is.
    #[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
    pub(crate) fn begin_source_session(
        &mut self,
        control: &Control,
    ) -> Result<u64, crate::application_audio::Failure> {
        use crate::application_audio::Failure;
        self.sync();
        if control.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        // Another session, or a start still loading: busy, as an
        // ordinary start would be told.
        let starting = self
            .live_start
            .control()
            .map_err(|_| Failure::Unavailable)?
            .1
            != StartupState::Idle;
        if self.live.is_some()
            || starting
            || matches!(self.engine.state.status, Status::Running | Status::Paused)
        {
            return Err(Failure::Busy);
        }
        let ticket = self.begin_live_start().map_err(|_| Failure::Unavailable)?;
        let session = self
            .install_live_start(&ticket)
            .map_err(|_| Failure::Unavailable)?;
        // The ticket ends here, so startup reads idle; the operation it set
        // stays current for the source's attachment and for Stop.
        drop(ticket);
        self.source_session = Some(SourceSession {
            session,
            control: control.clone(),
        });
        Ok(session)
    }

    /// Whether the running live session is one started for a source alone.
    #[cfg(test)]
    pub(crate) fn is_source_session(&self, session: u64) -> bool {
        self.source_session
            .as_ref()
            .is_some_and(|own| own.session == session)
            && self.live_session() == Some(session)
    }

    /// End a source-only session, if `session` is still it. There is no
    /// microphone to release and no transcript to drain: the source's audio
    /// was already discarded when it stopped. Returns whether it ended.
    pub(crate) fn end_source_session(&mut self, session: u64) -> bool {
        if !self
            .source_session
            .as_ref()
            .is_some_and(|own| own.session == session)
        {
            return false;
        }
        if let Some(own) = self.source_session.take() {
            own.control.cancel();
        }
        if self.live_session() == Some(session) {
            if let Some(live) = self.take_live_for_stop() {
                #[cfg(all(
                    debug_assertions,
                    target_os = "macos",
                    feature = "native-audio-spike",
                    feature = "lab-evaluator"
                ))]
                self.lab_stop_drains.acknowledge(
                    live.session,
                    live.microphone.is_none() && live.runner.is_none(),
                );
                // Only the exact empty source-session handle taken here is
                // acknowledged. A drain already owned by another Stop stays pending.
                drop(live);
            }
        }
        self.engine.finish_live_stop(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application_audio::{
            chunks::ChunkError,
            handoff::{Format, Input, Reader, Rejected},
            timing::TimingError,
            Application, Capture, Failure, Gate, Phase,
        },
        engine::StopTarget,
        Engine,
    };

    fn live() -> Runtime {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
        runtime
    }

    struct Source {
        gate: Gate,
        control: Control,
        capture: Capture<()>,
        input: Input,
        reader: Option<Reader>,
    }

    /// A fictional 16 kHz mono source that is approved and accepted as
    /// capturing. Samples are synthetic; no device or OS API is involved.
    fn source(id: &str) -> Source {
        let gate = Gate::default();
        let mut review = gate
            .review(Application::new(id.into(), "Fictional player".into()).unwrap())
            .unwrap();
        let control = review.control();
        let mut start = gate.approve(&mut review).unwrap();
        let (input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 4).unwrap();
        let capture = start.run(|_, _| Ok(())).unwrap();
        Source {
            gate,
            control,
            capture,
            input,
            reader: Some(reader),
        }
    }

    const CANCELLED: TimingError = TimingError::Handoff(Rejected::Cancelled);

    #[test]
    fn every_stop_path_cancels_delivery_queued_audio_and_returned_work() {
        for path in 0..3 {
            let mut runtime = live();
            let session = runtime.engine.session();
            let mut source = source("fictional-player");
            runtime.attach_live_source(&source.control).unwrap();
            let mut reader = source.reader.take().unwrap().bind_session(session, 0);
            // One block is already with the worker and one is still queued
            // when Stop arrives; a third push stands for the next callback.
            source.input.push(&source.control, 0, &[0.1; 160]).unwrap();
            source
                .input
                .push(&source.control, 160, &[0.2; 160])
                .unwrap();
            let returned = reader.try_next(session).unwrap().unwrap();
            assert!(returned.belongs_to(session, &source.control));

            match path {
                0 => {
                    runtime.take_live_for_stop().unwrap();
                }
                1 => {
                    let target = StopTarget {
                        operation: runtime.live_start.control().unwrap().0,
                        microphone: "0".into(),
                    };
                    assert!(runtime
                        .prepare_capture_stop(&target)
                        .unwrap()
                        .live
                        .is_some());
                }
                _ => drop(runtime), // The runtime itself going away.
            }

            // Stop did not wait for a worker, a callback or the gate.
            assert!(source.control.is_cancelled(), "path {path}");
            assert_eq!(
                source.input.push(&source.control, 320, &[0.3; 160]),
                Err(Rejected::Cancelled)
            );
            assert!(!returned.belongs_to(session, &source.control));
            assert_eq!(reader.try_next(session).err(), Some(CANCELLED));
            // The gate stays reserved until the owner releases its resource,
            // so another source cannot overlap the one being cleaned up.
            assert_eq!(source.gate.snapshot().unwrap().phase, Phase::Capturing);
            assert!(matches!(
                source
                    .gate
                    .review(Application::new("next".into(), "Fictional player".into()).unwrap()),
                Err(Failure::Busy)
            ));
            drop(source.capture);
            assert_eq!(source.gate.snapshot().unwrap().phase, Phase::Idle);
        }
    }

    #[test]
    fn stop_discards_a_partly_assembled_chunk_instead_of_flushing_it() {
        let mut runtime = live();
        let session = runtime.engine.session();
        let mut source = source("fictional-player");
        runtime.attach_live_source(&source.control).unwrap();
        let mut chunker = source
            .reader
            .take()
            .unwrap()
            .bind_session(session, 0)
            .into_chunks()
            .unwrap();
        // Less than one full chunk, followed by a gap that would otherwise
        // release the audio before it.
        source
            .input
            .push(&source.control, 0, &[0.1; 2_048])
            .unwrap();
        assert!(chunker.try_next(session).unwrap().is_none());
        source
            .input
            .push(&source.control, 4_096, &[0.2; 2_048])
            .unwrap();
        runtime.take_live_for_stop().unwrap();
        assert_eq!(
            chunker.try_next(session).err(),
            Some(ChunkError::Timing(CANCELLED))
        );
        assert_eq!(
            chunker.try_next(session).err(),
            Some(ChunkError::Timing(CANCELLED))
        );
    }

    #[test]
    fn a_session_that_ends_is_replaced_or_starts_stopping_retires_its_source_on_sync() {
        for case in 0..3 {
            let mut runtime = live();
            let old_session = runtime.engine.session();
            let source = source("fictional-player");
            runtime.attach_live_source(&source.control).unwrap();
            runtime.sync();
            assert!(!source.control.is_cancelled(), "a current session keeps it");
            match case {
                0 => runtime.engine.end(),
                1 => {
                    runtime.engine = crate::carry_over(&runtime.engine, Engine::live());
                    runtime.engine.start().unwrap();
                }
                _ => runtime.engine.begin_live_stop(),
            }
            runtime.sync();
            assert!(source.control.is_cancelled(), "case {case}");
            assert!(runtime.live_source.is_none());
            // The retired source cannot come back, in this or a later session.
            assert_eq!(
                runtime.attach_live_source(&source.control),
                Err(Refused::SessionChanged)
            );
            if case == 0 {
                drop(runtime.take_live_for_stop());
                let ticket = runtime.begin_live_start().unwrap();
                runtime.install_live_start(&ticket).unwrap();
                assert_ne!(runtime.engine.session(), old_session);
                assert_eq!(
                    runtime.attach_live_source(&source.control),
                    Err(Refused::SessionChanged)
                );
                // A newly approved source serves the new session, and the old
                // session's Stop can no longer reach it.
                let next = self::source("fictional-player");
                runtime.attach_live_source(&next.control).unwrap();
                source.gate.stop(&source.control).unwrap();
                runtime.sync();
                assert!(!next.control.is_cancelled());
            }
        }
    }

    #[test]
    fn a_sink_holding_the_runtime_lock_cannot_commit_a_line_after_stop() {
        use std::sync::{mpsc, Arc, Mutex};
        let runtime = Arc::new(Mutex::new(live()));
        let session = runtime.lock().unwrap().engine.session();
        let source = source("fictional-player");
        let stranger = self::source("fictional-player");
        runtime
            .lock()
            .unwrap()
            .attach_live_source(&source.control)
            .unwrap();
        // The worker's own check passes, then it waits for the runtime lock
        // that Stop is holding: the window between check and commit.
        let (checked, proceed) = mpsc::channel();
        let (shared, control) = (runtime.clone(), source.control.clone());
        let stopping = runtime.lock().unwrap();
        let worker = std::thread::spawn(move || {
            assert!(!control.is_cancelled());
            checked.send(()).unwrap();
            let runtime = shared.lock().unwrap();
            runtime.live_source_accepts(session, &control)
        });
        proceed
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let mut stopping = stopping;
        assert!(stopping.live_source_accepts(session, &source.control));
        // Same application, but never attached to this session.
        assert!(!stopping.live_source_accepts(session, &stranger.control));
        assert!(!stopping.live_source_accepts(session + 1, &source.control));
        stopping.take_live_for_stop().unwrap();
        assert_eq!(stopping.engine.session(), session, "Stop keeps the number");
        drop(stopping);
        assert!(!worker.join().unwrap(), "the late line is refused");
    }

    #[test]
    fn the_source_sink_takes_lines_only_from_the_attached_source_of_a_running_session() {
        let line = |id: &str, at_ms| crate::engine::Segment {
            id: id.into(),
            at_ms,
            speaker: "Speaker 1".into(),
            text: "A fictional line.".into(),
        };
        let mut runtime = live();
        let session = runtime.engine.session();
        let source = source("fictional-player");
        // Same application and a valid session number, but never attached.
        let stranger = self::source("fictional-player");
        runtime.attach_live_source(&source.control).unwrap();
        runtime
            .ingest_source_line(session, &source.control, line("a1", 0))
            .unwrap();
        assert_eq!(
            runtime.ingest_source_line(session, &stranger.control, line("b1", 0)),
            Err(LineRefused::NotAttached)
        );
        // An engine refusal is a different answer: the source stays attached.
        assert!(matches!(
            runtime.ingest_source_line(session, &source.control, line("a1", 0)),
            Err(LineRefused::Engine(_))
        ));
        assert!(runtime
            .ingest_source_line(session + 1, &source.control, line("a2", 0))
            .is_err());
        // Stop keeps the engine running for the microphone's queued audio;
        // this source's lines are refused all the same.
        runtime.take_live_for_stop().unwrap();
        assert_eq!(runtime.engine.state.status, Status::Running);
        assert_eq!(
            runtime.ingest_source_line(session, &source.control, line("a3", 0)),
            Err(LineRefused::NotAttached)
        );
        runtime.engine.ingest(session, line("m1", 0)).unwrap();
        let ids: Vec<_> = runtime
            .engine
            .state
            .transcript
            .iter()
            .map(|line| line.id.as_str())
            .collect();
        assert_eq!(ids, ["a1", "m1"]);
    }

    #[test]
    fn a_second_source_is_refused_until_the_first_has_stopped() {
        let mut runtime = live();
        let first = source("fictional-player");
        let second = source("fictional-other-player");
        runtime.attach_live_source(&first.control).unwrap();
        assert_eq!(
            runtime.attach_live_source(&second.control),
            Err(Refused::Occupied)
        );
        // Attaching the same operation again is not a refresh either.
        assert_eq!(
            runtime.attach_live_source(&first.control),
            Err(Refused::Occupied)
        );
        assert!(!first.control.is_cancelled() && !second.control.is_cancelled());
        // The first source stops by itself; the live session continues.
        first.gate.stop(&first.control).unwrap();
        runtime.attach_live_source(&second.control).unwrap();
        runtime.sync();
        assert!(!second.control.is_cancelled());
        assert!(runtime.live_source_operation().is_some());
        runtime.take_live_for_stop().unwrap();
        assert!(second.control.is_cancelled());
    }

    #[test]
    fn only_a_running_live_session_accepts_a_source_and_cue_pause_keeps_it() {
        for case in 0..6 {
            let mut runtime = live();
            let source = source("fictional-player");
            match case {
                0 => {
                    runtime = Runtime::default();
                    runtime.engine.start().unwrap(); // A session that is not live.
                }
                1 => runtime.engine.end(),
                2 => runtime.engine.begin_live_stop(),
                3 => {
                    runtime.take_live_for_stop().unwrap();
                }
                4 => {
                    source.gate.stop(&source.control).unwrap();
                }
                _ => runtime.engine.set_live_cues_paused(true).unwrap(),
            }
            let attached = runtime.attach_live_source(&source.control);
            if case == 5 {
                attached.unwrap();
                runtime.engine.set_live_cues_paused(false).unwrap();
                runtime.sync();
                assert!(!source.control.is_cancelled());
            } else {
                assert_eq!(attached, Err(Refused::SessionChanged), "case {case}");
                assert!(runtime.live_source.is_none());
                // A refusal never cancels a source it did not accept.
                assert_eq!(source.control.is_cancelled(), case == 4);
            }
        }
    }

    #[test]
    fn a_source_session_starts_without_a_microphone_and_is_refused_beside_another() {
        // Another session, live or not, is running: nothing starts.
        let mut running = live();
        let before = running.engine.session();
        let source = source("fictional-player");
        use crate::application_audio::Failure;
        assert_eq!(
            running.begin_source_session(&source.control),
            Err(Failure::Busy)
        );
        assert_eq!(running.engine.session(), before);
        assert!(!running.is_source_session(before));
        let mut other = Runtime::default();
        other.engine.start().unwrap();
        assert_eq!(
            other.begin_source_session(&source.control),
            Err(Failure::Busy)
        );
        // A start that is still loading is busy too.
        let mut loading = Runtime::default();
        let _ticket = loading.begin_live_start().unwrap();
        assert_eq!(
            loading.begin_source_session(&source.control),
            Err(Failure::Busy)
        );
        // A stopped source starts no session.
        let mut idle = Runtime::default();
        let stopped = self::source("fictional-player");
        stopped.gate.stop(&stopped.control).unwrap();
        assert_eq!(
            idle.begin_source_session(&stopped.control),
            Err(Failure::Cancelled)
        );
        assert!(idle.live.is_none());

        let mut runtime = Runtime::default();
        let session = runtime.begin_source_session(&source.control).unwrap();
        assert!(runtime.is_source_session(session));
        let live = runtime.live.as_ref().unwrap();
        assert!(live.microphone.is_none() && live.runner.is_none());
        assert_eq!(runtime.engine.state.status, Status::Running);
        assert!(runtime.engine.state.live);
        // Startup reads idle; the session's operation stays current, so the
        // source can attach and Stop can name it.
        let (_, startup) = runtime.live_start.control().unwrap();
        assert_eq!(startup, StartupState::Idle);
        assert!(runtime.live_source_operation().is_some());
        runtime.attach_live_source(&source.control).unwrap();
    }

    #[test]
    fn stopping_a_source_session_stops_its_source_even_before_it_attaches() {
        let mut runtime = Runtime::default();
        let source = source("fictional-player");
        let session = runtime.begin_source_session(&source.control).unwrap();
        assert!(!source.control.is_cancelled());
        // Stop live session, before the source has attached.
        drop(runtime.take_live_for_stop().unwrap());
        assert!(
            source.control.is_cancelled(),
            "the pending source stops too"
        );
        assert!(runtime.engine.finish_live_stop(session));
        runtime.sync();
        assert!(!runtime.is_source_session(session));
        assert_eq!(
            runtime.attach_live_source(&source.control),
            Err(Refused::SessionChanged)
        );
    }

    #[test]
    fn a_source_session_ends_when_its_attached_source_stops_by_itself() {
        let mut runtime = Runtime::default();
        let source = source("fictional-player");
        let session = runtime.begin_source_session(&source.control).unwrap();
        runtime.attach_live_source(&source.control).unwrap();
        runtime.sync();
        assert_eq!(runtime.engine.state.status, Status::Running);
        // The source's own Stop, or a stream failure: the next sync detaches
        // it and ends the session that only it fed.
        source.gate.stop(&source.control).unwrap();
        runtime.sync();
        assert!(runtime.live.is_none() && runtime.live_source.is_none());
        assert_eq!(runtime.engine.state.status, Status::Ended);
        assert!(!runtime.is_source_session(session));
        // An ordinary live session does not end when its source stops.
        let mut ordinary = live();
        let other = self::source("fictional-player");
        ordinary.attach_live_source(&other.control).unwrap();
        other.gate.stop(&other.control).unwrap();
        ordinary.sync();
        assert_eq!(ordinary.engine.state.status, Status::Running);
        assert!(ordinary.live.is_some());
    }

    #[test]
    fn ending_a_source_session_twice_or_after_a_replacement_changes_nothing() {
        let mut runtime = Runtime::default();
        let source = source("fictional-player");
        let session = runtime.begin_source_session(&source.control).unwrap();
        assert!(runtime.end_source_session(session));
        assert!(!runtime.end_source_session(session));
        // A later ordinary session is not ended by the old session's step.
        let ticket = runtime.begin_live_start().unwrap();
        let next = runtime.install_live_start(&ticket).unwrap();
        assert!(!runtime.end_source_session(session));
        assert_eq!(runtime.engine.session(), next);
        assert_eq!(runtime.engine.state.status, Status::Running);
    }

    #[test]
    fn the_notebook_stop_reaches_a_source_session_through_its_displayed_target() {
        use crate::capture_control::StopPlan;
        let mut runtime = Runtime::default();
        let source = source("fictional-player");
        let session = runtime.begin_source_session(&source.control).unwrap();
        // The target the notebook shows: this session's operation and the
        // microphone controller's current generation, which has none here.
        let target = StopTarget {
            operation: runtime.live_start.control().unwrap().0,
            microphone: "0".into(),
        };
        let StopPlan { live, microphone } = runtime.prepare_capture_stop(&target).unwrap();
        let live = live.expect("the session was taken for Stop");
        assert_eq!(live.session, session);
        assert!(live.microphone.is_none() && live.runner.is_none());
        assert_eq!(
            microphone, 0,
            "only the displayed generation, none of its own"
        );
        assert!(source.control.is_cancelled(), "the source stops with it");
        // finish_live then ends the engine session.
        assert!(runtime.engine.finish_live_stop(session));
        assert!(!runtime.source_session_running());
    }

    #[test]
    fn the_companion_learns_of_a_source_session_only_while_it_runs() {
        let mut runtime = Runtime::default();
        let plain = serde_json::to_value(runtime.cue_snapshot()).unwrap();
        assert!(plain.get("sourceSession").is_none());
        let source = source("fictional-player");
        runtime.begin_source_session(&source.control).unwrap();
        runtime.attach_live_source(&source.control).unwrap();
        let running = serde_json::to_value(runtime.cue_snapshot()).unwrap();
        assert_eq!(running["sourceSession"], true);
        assert!(
            !runtime.microphone_may_start(),
            "no microphone check inside it"
        );
        // Its source is stopped: the flag goes at once, before the session
        // itself has ended.
        source.gate.stop(&source.control).unwrap();
        assert!(serde_json::to_value(runtime.cue_snapshot())
            .unwrap()
            .get("sourceSession")
            .is_none());
        runtime.sync();
        assert!(runtime.live.is_none());
        assert!(runtime.microphone_may_start());
        // An ordinary live session never carries it, and also refuses a
        // standalone microphone check.
        let ordinary = live();
        assert!(serde_json::to_value(ordinary.cue_snapshot())
            .unwrap()
            .get("sourceSession")
            .is_none());
        assert!(!ordinary.microphone_may_start());
    }

    #[test]
    fn a_source_session_ends_on_sync_when_its_source_is_stopped_before_attaching() {
        let mut runtime = Runtime::default();
        let source = source("fictional-player");
        let session = runtime.begin_source_session(&source.control).unwrap();
        runtime.sync();
        assert!(
            runtime.source_session_running(),
            "still loading, not stopped"
        );
        assert_eq!(runtime.engine.state.status, Status::Running);
        // Stop application audio while the worker is still loading its
        // recognizer: the source never attached.
        source.gate.stop(&source.control).unwrap();
        runtime.sync();
        assert!(
            runtime.live.is_none(),
            "ended at once, not when the run returns"
        );
        assert_eq!(runtime.engine.state.status, Status::Ended);
        assert!(!runtime.is_source_session(session));
        // The worker's own end step later changes nothing.
        assert!(!runtime.end_source_session(session));
    }
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    #[test]
    fn source_teardown_acknowledges_only_the_empty_handle_it_owns() {
        let mut runtime = Runtime::default();
        let first_source = source("fictional-player");
        let session = runtime.begin_source_session(&first_source.control).unwrap();
        assert!(runtime.end_source_session(session));
        assert!(runtime.lab_stop_drains.settled());

        let source = source("fictional-replacement");
        let session = runtime.begin_source_session(&source.control).unwrap();
        let ordinary_stop = runtime.take_live_for_stop().unwrap();
        runtime.end_source_session(session);
        assert!(
            !runtime.lab_stop_drains.settled(),
            "source end cannot acknowledge another Stop's handle"
        );
        runtime
            .lab_stop_drains
            .acknowledge(ordinary_stop.session, true);
        drop(ordinary_stop);
        assert!(runtime.lab_stop_drains.settled());
    }
}
