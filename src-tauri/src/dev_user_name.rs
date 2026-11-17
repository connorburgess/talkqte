//! Launch-only developer setting for lab runs: the user's name, as if typed
//! in Settings, from `TALKQTE_DEV_USER_NAME`. Read only in debug builds. The
//! name stays in memory, the person can still change or clear it, and it is
//! never logged; the timing log records only whether a name is set.
use crate::engine::{valid_user_name, Engine};
use std::{env::VarError, sync::OnceLock};

/// None when the setting is absent; an error when it is present but is not
/// a name Settings would accept.
static NAME: OnceLock<Result<Option<String>, ()>> = OnceLock::new();

fn parse(value: Result<String, VarError>) -> Result<Option<String>, ()> {
    match value {
        Err(VarError::NotPresent) => Ok(None),
        Err(VarError::NotUnicode(_)) => Err(()),
        Ok(value) => {
            let name = value.trim();
            if !name.is_empty() && valid_user_name(name) {
                Ok(Some(name.to_string()))
            } else {
                Err(())
            }
        }
    }
}

/// Reads the setting once, during setup.
pub(crate) fn initialize() {
    NAME.get_or_init(|| parse(std::env::var("TALKQTE_DEV_USER_NAME")));
}

/// Sets the name on the launch's first engine, before any session.
pub(crate) fn apply(engine: &mut Engine) {
    if let Some(Ok(Some(name))) = NAME.get() {
        let _ = engine.set_user_name(Some(name.clone()));
    }
}

/// Why a live session cannot start, when the setting was given but cannot
/// be used, so the lab learns of it before any approval.
#[cfg(any(
    feature = "local-whisper",
    all(target_os = "macos", feature = "native-audio-spike"),
    test
))]
pub(crate) fn refusal() -> Option<&'static str> {
    refusal_for(NAME.get())
}

#[cfg(any(
    feature = "local-whisper",
    all(target_os = "macos", feature = "native-audio-spike"),
    test
))]
fn refusal_for(setting: Option<&Result<Option<String>, ()>>) -> Option<&'static str> {
    matches!(setting, Some(Err(()))).then_some("The developer name setting is not usable.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_accepts_what_settings_accepts_and_refuses_the_rest() {
        let name = |value: &str| parse(Ok(value.into()));
        assert_eq!(parse(Err(VarError::NotPresent)), Ok(None));
        assert_eq!(name("Curtis"), Ok(Some("Curtis".into())));
        assert_eq!(name(" Zoë O’Neil-Ray "), Ok(Some("Zoë O’Neil-Ray".into())));
        for bad in ["", "   ", "Curtis2", "C;urtis", "-'", &"a".repeat(41)] {
            assert_eq!(name(bad), Err(()), "{bad:?}");
        }
        assert_eq!(
            parse(Err(VarError::NotUnicode(std::ffi::OsString::new()))),
            Err(())
        );
    }

    #[test]
    fn only_an_unusable_setting_refuses_a_live_session() {
        assert!(refusal_for(Some(&Err(()))).is_some());
        assert!(refusal_for(Some(&Ok(None))).is_none());
        assert!(refusal_for(Some(&Ok(Some("Curtis".into())))).is_none());
        assert!(refusal_for(None).is_none(), "setup never read it");
    }

    #[test]
    fn a_given_name_is_set_as_if_typed_and_can_still_be_changed() {
        let mut engine = Engine::live();
        let _ = NAME.set(Ok(Some("Curtis".into())));
        apply(&mut engine);
        if NAME.get() == Some(&Ok(Some("Curtis".into()))) {
            assert_eq!(engine.state.user_name.as_deref(), Some("Curtis"));
            engine.set_user_name(None).unwrap();
            assert_eq!(engine.state.user_name, None);
        }
    }
}
