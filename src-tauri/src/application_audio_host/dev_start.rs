//! Development builds only: start one application's audio from a launch
//! setting, for lab runs with fictional audio that nobody is at the Mac for.
//!
//! `TALKQTE_DEV_APPLICATION_SOURCE` names the application exactly. Setting it
//! is the developer's acknowledgement of the scope notice. At launch the host
//! then takes the same steps the panel does, once: list, review the one
//! application with that exact name, and start a session from it alone. The
//! microphone is never started. A missing match, a refused permission or any
//! other refusal ends the attempt with its reason in the panel, on stderr and
//! in the timing log; nothing is retried, so macOS is asked at most once.
//!
//! `TALKQTE_DEV_APPLICATION_WITH_MICROPHONE=1` changes the last step, for a
//! call with both sides: after finding the application, the host waits for a
//! live session the person has started from the microphone in the notebook,
//! then attaches the application to that session instead of starting one of
//! its own. The setting never starts the microphone or approves processing.
//! Stop by this setting stops the application only; the microphone session
//! runs until the person stops it. A lab run does not accept this setting.
//!
//! `TALKQTE_DEV_STOP_AFTER_S`, if set, asks the host's ordinary Stop that many
//! seconds after capture is confirmed. Nothing else is stopped or forced.

use super::*;
use crate::timing_log::{self, Event};

pub(crate) const SOURCE_ENV: &str = "TALKQTE_DEV_APPLICATION_SOURCE";
pub(crate) const STOP_AFTER_ENV: &str = "TALKQTE_DEV_STOP_AFTER_S";
pub(crate) const WITH_MICROPHONE_ENV: &str = "TALKQTE_DEV_APPLICATION_WITH_MICROPHONE";

/// How long listing may wait, for example behind the one-time macOS prompt,
/// before the attempt gives up and cancels it.
pub(crate) const LIST_WAIT: Duration = Duration::from_secs(120);
/// How long a start may take to be confirmed or refused.
pub(crate) const START_WAIT: Duration = Duration::from_secs(60);
/// How long the person has to start the microphone session the application
/// is to join.
pub(crate) const MICROPHONE_WAIT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_millis(50);

/// The launch settings, read once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Settings {
    pub application: String,
    /// Invalid when the stop setting is present but not a whole number of
    /// seconds from 1 upward; nothing is started then.
    pub stop_after: Result<Option<Duration>, ()>,
    /// Join a microphone session the person starts, instead of starting a
    /// session for the application alone. Invalid when the setting is
    /// present but not exactly `1`; nothing is started then.
    pub with_microphone: Result<bool, ()>,
}

impl Settings {
    /// None unless the source setting names an application.
    pub(crate) fn read(lookup: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let application = lookup(SOURCE_ENV).filter(|name| !name.trim().is_empty())?;
        let stop_after = match lookup(STOP_AFTER_ENV) {
            None => Ok(None),
            Some(text) => match text.trim().parse::<u64>() {
                Ok(seconds) if seconds > 0 => Ok(Some(Duration::from_secs(seconds))),
                _ => Err(()),
            },
        };
        let with_microphone = match lookup(WITH_MICROPHONE_ENV) {
            None => Ok(false),
            Some(text) if text == "1" => Ok(true),
            Some(_) => Err(()),
        };
        Some(Self {
            application,
            stop_after,
            with_microphone,
        })
    }
}

/// How the attempt ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Capture was confirmed and, if asked, Stop was requested later.
    Started { stopped: bool },
    /// Nothing was captured, for this reason.
    Refused(&'static str),
}

/// How long each wait in an attempt may last. Tests shorten them.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Waits {
    pub list: Duration,
    pub start: Duration,
    pub microphone: Duration,
    pub poll: Duration,
}

impl Default for Waits {
    fn default() -> Self {
        Self {
            list: LIST_WAIT,
            start: START_WAIT,
            microphone: MICROPHONE_WAIT,
            poll: POLL,
        }
    }
}

fn say(step: &'static str, application: &str, reason: Option<&str>) {
    match reason {
        Some(reason) => eprintln!("TalkQTE development source: {step} ({reason})."),
        None => eprintln!("TalkQTE development source: {step}."),
    }
    timing_log::record(Event::DevSource {
        step,
        application: application.to_owned(),
        reason: reason.map(str::to_owned),
    });
}

fn label(problem: Problem) -> String {
    serde_json::to_value(problem)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

impl Host {
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    pub(super) fn lab_listening_candidate(
        &self,
        operation: &str,
    ) -> Option<crate::dev_source_observation::Candidate> {
        let state = self.0.state.try_lock().ok()?;
        let active = state.active.as_ref()?;
        let view = state.last.as_ref()?;
        if !state.by_setting
            || state.exiting
            || active.id != operation
            || view.phase != Phase::Listening
            || view.operation.as_deref() != Some(operation)
            || !active.session_only
            || !active.session_started.load(Ordering::Acquire)
            || active.stop_requested
            || active.control.is_cancelled()
            || !crate::dev_lab_source::supports(active.application.name())
            || active.ended.try_lock().ok()?.is_some()
        {
            return None;
        }
        Some(crate::dev_source_observation::Candidate {
            host_operation: active.id.clone(),
            control: active.control.clone(),
            kind: crate::dev_lab_source::Kind::from_name(active.application.name())?,
        })
    }

    /// Show `problem` as why the setting started nothing.
    fn refuse_by_setting(&self, problem: Problem) {
        let mut state = self.lock();
        if state.active.is_none() {
            state.problem = Some(problem);
        }
    }

    /// One attempt for `settings`, blocking the calling thread, which must
    /// not be the worker or hold the runtime lock.
    #[cfg(test)]
    pub(crate) fn start_by_setting(&self, settings: &Settings, waits: Waits) -> Outcome {
        self.start_by_setting_observed(settings, waits, |_| true)
    }

    pub(super) fn start_by_setting_observed(
        &self,
        settings: &Settings,
        waits: Waits,
        observe: impl FnOnce(&str) -> bool,
    ) -> Outcome {
        // A lab run binds a session for the application alone.
        self.start_by_setting_joining(settings, waits, None::<fn() -> bool>, observe)
    }

    /// As `start_by_setting`. When the settings ask to join the microphone,
    /// `microphone_running` says whether a live microphone session can take
    /// a source now; without it that setting is refused.
    pub(crate) fn start_by_setting_joining(
        &self,
        settings: &Settings,
        waits: Waits,
        microphone_running: Option<impl Fn() -> bool>,
        observe: impl FnOnce(&str) -> bool,
    ) -> Outcome {
        let name = settings.application.as_str();
        let refuse = |reason: &'static str, problem: Option<Problem>| {
            if let Some(problem) = problem {
                self.refuse_by_setting(problem);
            }
            say("refused", name, Some(reason));
            Outcome::Refused(reason)
        };
        let Ok(stop_after) = settings.stop_after else {
            return refuse("stop_after_invalid", Some(Problem::DevSettingInvalid));
        };
        let microphone_running = match (settings.with_microphone, microphone_running) {
            (Err(()), _) => {
                return refuse("with_microphone_invalid", Some(Problem::DevSettingInvalid))
            }
            (Ok(false), _) => None,
            (Ok(true), Some(running)) => Some(running),
            (Ok(true), None) => {
                return refuse(
                    "with_microphone_unsupported",
                    Some(Problem::DevSettingInvalid),
                )
            }
        };
        self.lock().by_setting = true;
        say("acknowledged", name, None);
        if self.list(true).is_err() {
            return refuse("busy", None);
        }
        let deadline = Instant::now() + waits.list;
        let listed = loop {
            let view = self.snapshot().view;
            if view.phase != Phase::Listing {
                break view;
            }
            if Instant::now() >= deadline {
                let _ = self.cancel_list();
                return refuse("list_timed_out", Some(Problem::ListFailed));
            }
            std::thread::sleep(waits.poll);
        };
        match listed.problem {
            Some(Problem::PermissionDenied) => return refuse("permission_denied", None),
            Some(Problem::ListFailed) => return refuse("list_failed", None),
            _ => {}
        }
        let matches: Vec<_> = listed
            .choices
            .iter()
            .filter(|choice| choice.name == name)
            .collect();
        let [choice] = matches.as_slice() else {
            return refuse(
                if matches.is_empty() {
                    "no_matching_application"
                } else {
                    "several_matching_applications"
                },
                Some(Problem::NoMatchingApplication),
            );
        };
        let choice = choice.id.clone();
        if let Some(running) = &microphone_running {
            say("waiting_for_microphone", name, None);
            let deadline = Instant::now() + waits.microphone;
            while !running() {
                if Instant::now() >= deadline {
                    return refuse("microphone_not_started", None);
                }
                std::thread::sleep(waits.poll);
            }
        }
        if self.review(&choice).is_err() {
            return refuse("busy", None);
        }
        let Some(review) = self.snapshot().view.operation else {
            return refuse("busy", None);
        };
        let started = match microphone_running {
            Some(_) => self.start(&review),
            None => self.start_session(&review),
        };
        if started.is_err() {
            return refuse("busy", None);
        }
        let deadline = Instant::now() + waits.start;
        let operation = loop {
            let view = self.snapshot().view;
            match view.phase {
                Phase::Listening => break view.operation,
                Phase::Starting if Instant::now() < deadline => {}
                Phase::Starting => return refuse("start_timed_out", None),
                Phase::Off => {
                    let reason = view.problem.map(label);
                    say(
                        "refused",
                        name,
                        Some(reason.as_deref().unwrap_or("stopped")),
                    );
                    return Outcome::Refused("start_refused");
                }
                // Stopped by someone else, or failing: the status says how.
                _ => return refuse("stopped_before_capture", None),
            }
            std::thread::sleep(waits.poll);
        };
        let observed = operation.as_deref().is_some_and(observe);
        if observed {
            say("started", name, None);
        } else {
            // Readiness failure closes the same selected source, without
            // bypassing the independent timed-Stop loop below.
            if let Some(operation) = operation.as_deref() {
                let _ = self.stop(operation);
            }
            say("refused", name, Some("source_observation_unavailable"));
        }
        let outcome = |stopped| {
            if observed {
                Outcome::Started { stopped }
            } else {
                Outcome::Refused("source_observation_unavailable")
            }
        };
        let (Some(after), Some(operation)) = (stop_after, operation) else {
            return outcome(false);
        };
        let due = Instant::now() + after;
        while Instant::now() < due {
            let view = self.snapshot().view;
            // Already stopped, or a different run: leave it alone.
            if view.operation.as_deref() != Some(operation.as_str())
                || view.phase != Phase::Listening
            {
                return outcome(false);
            }
            std::thread::sleep(
                waits
                    .poll
                    .min(due.saturating_duration_since(Instant::now())),
            );
        }
        let stopped = self.stop(&operation).unwrap_or(false);
        if stopped {
            say("stopping", name, None);
        }
        outcome(stopped)
    }
}
