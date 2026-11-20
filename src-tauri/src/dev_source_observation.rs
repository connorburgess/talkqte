//! Content-free guard-time observations for one armed fictional source run.
//! Delivery is lossy; neither Listening nor retirement establishes release.
use crate::{application_audio::Control, timing_log::Event, Runtime};
use std::sync::Mutex;

pub(crate) struct Candidate {
    pub(crate) host_operation: String,
    pub(crate) control: Control,
    pub(crate) kind: crate::dev_lab_source::Kind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    run_id: String,
    host_operation: String,
    live_operation: String,
    session: String,
    kind: crate::dev_lab_source::Kind,
}
impl Identity {
    #[cfg(test)]
    pub(crate) fn new(run: &str, host: &str, live: &str, session: u64) -> Option<Self> {
        Self::for_kind(
            run,
            host,
            live,
            session,
            crate::dev_lab_source::Kind::QuickTime,
        )
    }
    pub(crate) fn for_kind(
        run: &str,
        host: &str,
        live: &str,
        session: u64,
        kind: crate::dev_lab_source::Kind,
    ) -> Option<Self> {
        let hex = |s: &str, n| {
            s.len() == n
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if run.is_empty()
            || run.len() > 64
            || !run
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || !hex(host, 32)
            || !hex(live, 64)
            || session == 0
        {
            return None;
        }
        Some(Self {
            run_id: run.into(),
            host_operation: host.into(),
            live_operation: live.into(),
            session: session.to_string(),
            kind,
        })
    }
    pub(crate) fn event(&self, step: &'static str) -> Event {
        Event::DevSourceObservation {
            version: 1,
            step,
            application: self.kind.name(),
            run_id: self.run_id.clone(),
            host_operation: self.host_operation.clone(),
            live_operation: self.live_operation.clone(),
            session: self.session.clone(),
        }
    }
}

pub(crate) fn observe(
    state: &Mutex<Runtime>,
    candidate: &Candidate,
    run: &str,
    stopped: impl FnOnce() -> bool,
) -> Option<Identity> {
    let mut runtime = state.try_lock().ok()?;
    runtime.observe_lab_source(candidate, run, stopped())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_player_keeps_one_application_identity_for_listening_and_retirement() {
        let identity = Identity::for_kind(
            "fictional-run",
            &"a".repeat(32),
            &"b".repeat(64),
            1,
            crate::dev_lab_source::Kind::OwnedPlayer,
        )
        .unwrap();
        let listening = serde_json::to_value(identity.event("listening")).unwrap();
        let retired = serde_json::to_value(identity.event("retired")).unwrap();
        assert_eq!(listening["application"], crate::dev_lab_source::PLAYER);
        for key in [
            "application",
            "run_id",
            "host_operation",
            "live_operation",
            "session",
        ] {
            assert_eq!(listening[key], retired[key]);
        }
        assert_eq!(retired["step"], "retired");
    }

    #[test]
    fn versioned_schema_contains_only_bounded_content_free_identity() {
        let identity =
            Identity::new("fictional-run", &"a".repeat(32), &"b".repeat(64), u64::MAX).unwrap();
        for step in ["listening", "retired"] {
            let value = serde_json::to_value(identity.event(step)).unwrap();
            let object = value.as_object().unwrap();
            let mut keys: Vec<_> = object.keys().map(String::as_str).collect();
            keys.sort();
            assert_eq!(
                keys,
                [
                    "application",
                    "event",
                    "host_operation",
                    "live_operation",
                    "run_id",
                    "session",
                    "step",
                    "version"
                ]
            );
            assert_eq!(value["event"], "dev_source_observation");
            assert_eq!(value["version"], 1);
            assert_eq!(value["session"], "18446744073709551615");
            assert_eq!(value["application"], "QuickTime Player");
            assert_eq!(value["step"], step);
        }
        for run in ["", "private/path", "words here", &"x".repeat(65)] {
            assert!(Identity::new(run, &"a".repeat(32), &"b".repeat(64), 1).is_none());
        }
        assert!(Identity::new("fictional-run", &"A".repeat(32), &"b".repeat(64), 1).is_none());
        assert!(Identity::new("fictional-run", &"a".repeat(31), &"b".repeat(64), 1).is_none());
        assert!(Identity::new("fictional-run", &"a".repeat(32), &"b".repeat(64), 0).is_none());
    }
}
