//! Ties one reviewed application-audio source to the live session it feeds.
//! Stopping or replacing that session cancels the source's operation under the
//! runtime lock with one atomic store: no native call and no wait on a worker,
//! callback or the review gate. The source's owner observes the cancellation
//! and cleans up on its own worker. Nothing here starts capture, and no app
//! command attaches a source. Attachment is not enforced by the audio types:
//! a caller that binds a reader to a session without attaching is not covered.

use crate::{
    application_audio::Control,
    engine::{StartupState, Status},
    Runtime,
};

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

impl Runtime {
    /// The startup operation of the live session a source may feed now. Demo,
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
    }

    /// For a transcript sink, with the runtime lock held, immediately before
    /// it commits a line from this source. A worker's own source check can
    /// pass just before Stop takes this lock; this one cannot, and it also
    /// refuses a source that was never attached.
    #[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
    #[cfg_attr(not(test), allow(dead_code))] // No application-audio sink exists yet.
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
        let Some(source) = &self.live_source else {
            return;
        };
        if source.control.is_cancelled()
            || source.session != self.engine.session()
            || self.live_source_operation() != Some(source.operation.as_str())
        {
            self.live_source = None;
        }
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
                    runtime.engine.start().unwrap(); // The fictional demo.
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
}
