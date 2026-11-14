//! Launch-only developer consent. Compiled only in debug builds with both
//! development features. Never reads sources or starts capture/provider work.
use crate::engine::{ConversationScope, Engine};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Settings {
    consent: bool,
    calls: u64,
}

impl Settings {
    fn parse(connection: Option<&str>, calls: Option<&str>) -> Result<Self, ()> {
        let consent = match connection {
            None => false,
            Some("on") => true,
            Some(_) => return Err(()),
        };
        let calls = match calls {
            None => 100,
            Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                value.parse::<u64>().map_err(|_| ())?
            }
            Some(_) => return Err(()),
        };
        if !(1..=100).contains(&calls) {
            return Err(());
        }
        Ok(Self { consent, calls })
    }

    fn apply(self, engine: &mut Engine) {
        engine.set_model_call_limit(self.calls);
        if self.consent {
            // Existing review validation binds the grant to this running session
            // and the backend. An empty note selection cannot expand sources.
            if let Ok(review) = engine.review_processing(ConversationScope::RecentAndNewSpeech, &[])
            {
                let _ = engine.approve_processing_with_origin(review, true);
            }
        }
    }
}

static SETTINGS: OnceLock<Result<Settings, ()>> = OnceLock::new();

/// Called during setup, before the application-audio launch task is installed.
pub(crate) fn initialize() {
    SETTINGS.get_or_init(|| {
        let connection = std::env::var("TALKQTE_DEV_MODEL_CONNECTION");
        let calls = std::env::var("TALKQTE_DEV_MODEL_CALLS");
        if matches!(connection, Err(std::env::VarError::NotUnicode(_)))
            || matches!(calls, Err(std::env::VarError::NotUnicode(_)))
        {
            return Err(());
        }
        Settings::parse(connection.as_deref().ok(), calls.as_deref().ok())
    });
}

pub(crate) fn apply(engine: &mut Engine) {
    // Tests or other constructors that did not pass native setup never read
    // the environment and never acquire consent as a side effect.
    match SETTINGS.get() {
        Some(Ok(settings)) => settings.apply(engine),
        Some(Err(())) => engine.invalid_dev_model_settings(),
        None => engine.set_model_call_limit(100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        struct Offline;
        impl crate::cue_evaluator::Evaluator for Offline {
            fn evaluate(
                &mut self,
                _: &crate::cue_evaluator::Request,
                _: &crate::cue_evaluator::Cancellation,
            ) -> Result<String, crate::cue_evaluator::Failure> {
                panic!("consent tests must not dispatch a request")
            }
        }
        let config = crate::engine::ProcessorConfiguration::new(
            "fictional".into(),
            1,
            "fixture".into(),
            crate::engine::ProcessingLocation::OnDevice,
            "fixture".into(),
            crate::engine::ProcessorDisclosure::new("Fictional".into(), "Offline test".into())
                .unwrap(),
        )
        .unwrap()
        .without_notes();
        let worker =
            crate::cue_evaluator::Worker::start(Offline, std::time::Duration::from_secs(1))
                .unwrap();
        let mut engine = Engine::live_with_evaluator(worker, config);
        engine.start().unwrap();
        engine
    }

    #[test]
    fn consent_is_session_scoped_and_controls_do_not_reapply_it() {
        let mut engine = engine();
        Settings::parse(None, None).unwrap().apply(&mut engine);
        assert!(!engine.has_processing_permission());
        Settings::parse(Some("on"), None)
            .unwrap()
            .apply(&mut engine);
        assert!(engine.has_processing_permission());
        let snapshot = engine.processing_snapshot(crate::engine::CaptureState::Running, 0);
        assert!(snapshot.approval_by_setting);
        assert!(snapshot.approved.unwrap().notes.is_empty());
        engine.set_live_cues_paused(true).unwrap();
        assert_eq!(
            engine.evaluation_status(),
            Some(crate::engine::EvaluationStatus::Idle)
        );
        engine.set_live_cues_paused(false).unwrap();
        engine.revoke_processing();
        engine.advance(10);
        assert!(!engine.has_processing_permission());
        engine.invalid_dev_model_settings();
        assert!(engine
            .review_processing(ConversationScope::RecentAndNewSpeech, &[])
            .is_err());
        assert_eq!(
            serde_json::to_value(engine.processing_issue()).unwrap(),
            "devSettings"
        );
    }

    #[test]
    fn only_exact_opt_in_grants_consent_and_caps_are_bounded() {
        assert_eq!(
            Settings::parse(None, None),
            Ok(Settings {
                consent: false,
                calls: 100
            })
        );
        assert_eq!(
            Settings::parse(Some("on"), Some("2")),
            Ok(Settings {
                consent: true,
                calls: 2
            })
        );
        for value in ["", "off", "ON", "true", " on"] {
            assert!(Settings::parse(Some(value), None).is_err());
        }
        for value in ["", "0", "101", "-1", "1.5", " 2", "18446744073709551616"] {
            assert!(Settings::parse(Some("on"), Some(value)).is_err());
        }
    }
}
