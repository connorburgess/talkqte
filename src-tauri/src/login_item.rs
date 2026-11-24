//! "Open at login": registers the app itself as a login item through
//! SMAppService (macOS 13 and later; the app's minimum is 14). Off by
//! default. The state shown is always read back from the system, never
//! remembered by TalkQTE, since the person can change it in System Settings.
//! Tests use a fake backend; nothing here registers anything during tests.

use serde::Serialize;

/// What the system says about TalkQTE as a login item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Not registered: TalkQTE does not open at login.
    Off,
    /// Registered and allowed: TalkQTE opens at login.
    On,
    /// Registered, but the person has to allow it in System Settings →
    /// General → Login Items before it opens at login.
    NeedsApproval,
    /// This build or launch cannot be a login item (not macOS, a lab run, or
    /// the system cannot find the app).
    Unavailable,
}

/// The system's login items, or a stand-in for tests.
pub trait Backend: Send + Sync {
    fn status(&self) -> Status;
    fn register(&self) -> Result<(), String>;
    fn unregister(&self) -> Result<(), String>;
    /// Opens System Settings at Login Items, where the person decides.
    fn open_settings(&self);
}

/// Turns Open at login on or off, then reads the state back from the
/// system: what the person sees is what macOS says, even when the change
/// failed or needs their approval.
pub fn change(backend: &dyn Backend, on: bool) -> (Status, Option<String>) {
    let before = backend.status();
    if before == Status::Unavailable {
        return (before, Some(UNAVAILABLE.into()));
    }
    let wanted = if on {
        matches!(before, Status::On | Status::NeedsApproval)
    } else {
        before == Status::Off
    };
    let result = if wanted {
        Ok(())
    } else if on {
        backend.register()
    } else {
        backend.unregister()
    };
    (backend.status(), result.err())
}

pub const UNAVAILABLE: &str = "Open at login is not available for this copy of TalkQTE.";

/// No login items: other platforms and lab runs.
pub struct Unavailable;

impl Backend for Unavailable {
    fn status(&self) -> Status {
        Status::Unavailable
    }
    fn register(&self) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    fn unregister(&self) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    fn open_settings(&self) {}
}

/// The main app as an SMAppService login item.
#[cfg(target_os = "macos")]
pub struct System;

#[cfg(target_os = "macos")]
impl Backend for System {
    fn status(&self) -> Status {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: class methods and a property read on the shared service.
        let status = unsafe { SMAppService::mainAppService().status() };
        match status {
            SMAppServiceStatus::Enabled => Status::On,
            SMAppServiceStatus::RequiresApproval => Status::NeedsApproval,
            SMAppServiceStatus::NotRegistered => Status::Off,
            _ => Status::Unavailable,
        }
    }
    fn register(&self) -> Result<(), String> {
        use objc2_service_management::SMAppService;
        // SAFETY: registers the calling app itself; no arguments.
        unsafe { SMAppService::mainAppService().registerAndReturnError() }
            .map_err(|_| "macOS did not add TalkQTE to your login items.".into())
    }
    fn unregister(&self) -> Result<(), String> {
        use objc2_service_management::SMAppService;
        // SAFETY: unregisters the calling app itself; no arguments.
        unsafe { SMAppService::mainAppService().unregisterAndReturnError() }
            .map_err(|_| "macOS did not remove TalkQTE from your login items.".into())
    }
    fn open_settings(&self) {
        use objc2_service_management::SMAppService;
        // SAFETY: opens System Settings; no arguments.
        unsafe { SMAppService::openSystemSettingsLoginItems() };
    }
}

/// The backend for the running app: the system's on macOS, none in a lab
/// run (which must leave the Mac as it found it) or elsewhere.
pub fn for_app() -> Box<dyn Backend> {
    #[cfg(target_os = "macos")]
    if !crate::settings::lab_run() {
        return Box::new(System);
    }
    Box::new(Unavailable)
}

/// Managed state: the backend this launch uses.
pub struct LoginItems(pub Box<dyn Backend>);

#[cfg(test)]
pub mod fake {
    use super::{Backend, Status};
    use std::sync::Mutex;

    /// An in-memory login item. `approval` makes a registration wait for the
    /// person, as macOS may; `fail` refuses every change.
    #[derive(Default)]
    pub struct Fake {
        pub state: Mutex<Option<Status>>,
        pub approval: bool,
        pub fail: bool,
        pub calls: Mutex<Vec<&'static str>>,
        pub opened: Mutex<u32>,
    }

    impl Backend for Fake {
        fn status(&self) -> Status {
            self.state.lock().unwrap().unwrap_or(Status::Off)
        }
        fn register(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("register");
            if self.fail {
                return Err("refused".into());
            }
            *self.state.lock().unwrap() = Some(if self.approval {
                Status::NeedsApproval
            } else {
                Status::On
            });
            Ok(())
        }
        fn unregister(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("unregister");
            if self.fail {
                return Err("refused".into());
            }
            *self.state.lock().unwrap() = Some(Status::Off);
            Ok(())
        }
        fn open_settings(&self) {
            *self.opened.lock().unwrap() += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fake::Fake, *};

    #[test]
    fn it_is_off_by_default_and_turning_it_on_registers_once() {
        let backend = Fake::default();
        assert_eq!(backend.status(), Status::Off);
        assert_eq!(change(&backend, true), (Status::On, None));
        // Already on: nothing more is asked of the system.
        assert_eq!(change(&backend, true), (Status::On, None));
        assert_eq!(*backend.calls.lock().unwrap(), ["register"]);
        assert_eq!(change(&backend, false), (Status::Off, None));
        assert_eq!(*backend.calls.lock().unwrap(), ["register", "unregister"]);
    }

    #[test]
    fn the_state_shown_is_what_the_system_says() {
        // macOS may hold a registration until the person allows it.
        let backend = Fake {
            approval: true,
            ..Fake::default()
        };
        assert_eq!(change(&backend, true), (Status::NeedsApproval, None));
        // A failed change reports the error and the unchanged state.
        let backend = Fake {
            fail: true,
            ..Fake::default()
        };
        assert_eq!(
            change(&backend, true),
            (Status::Off, Some("refused".into()))
        );
        // Changed in System Settings meanwhile: read, not assumed.
        let backend = Fake::default();
        change(&backend, true);
        *backend.state.lock().unwrap() = Some(Status::Off);
        assert_eq!(backend.status(), Status::Off);
    }

    #[test]
    fn a_build_or_launch_without_login_items_changes_nothing() {
        assert_eq!(
            change(&Unavailable, true),
            (Status::Unavailable, Some(UNAVAILABLE.into()))
        );
    }
}
