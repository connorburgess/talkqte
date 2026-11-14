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
//! `TALKQTE_DEV_STOP_AFTER_S`, if set, asks the host's ordinary Stop that many
//! seconds after capture is confirmed. Nothing else is stopped or forced.

use super::*;
use crate::timing_log::{self, Event};

pub(crate) const SOURCE_ENV: &str = "TALKQTE_DEV_APPLICATION_SOURCE";
pub(crate) const STOP_AFTER_ENV: &str = "TALKQTE_DEV_STOP_AFTER_S";

/// How long listing may wait, for example behind the one-time macOS prompt,
/// before the attempt gives up and cancels it.
pub(crate) const LIST_WAIT: Duration = Duration::from_secs(120);
/// How long a start may take to be confirmed or refused.
pub(crate) const START_WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(50);

/// The launch settings, read once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Settings {
    pub application: String,
    /// Invalid when the stop setting is present but not a whole number of
    /// seconds from 1 upward; nothing is started then.
    pub stop_after: Result<Option<Duration>, ()>,
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
        Some(Self {
            application,
            stop_after,
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
    pub poll: Duration,
}

impl Default for Waits {
    fn default() -> Self {
        Self {
            list: LIST_WAIT,
            start: START_WAIT,
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
    /// Show `problem` as why the setting started nothing.
    fn refuse_by_setting(&self, problem: Problem) {
        let mut state = self.lock();
        if state.active.is_none() {
            state.problem = Some(problem);
        }
    }

    /// One attempt for `settings`, blocking the calling thread, which must
    /// not be the worker or hold the runtime lock.
    pub(crate) fn start_by_setting(&self, settings: &Settings, waits: Waits) -> Outcome {
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
        if self.review(&choice.id).is_err() {
            return refuse("busy", None);
        }
        let Some(review) = self.snapshot().view.operation else {
            return refuse("busy", None);
        };
        if self.start_session(&review).is_err() {
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
        say("started", name, None);
        let (Some(after), Some(operation)) = (stop_after, operation) else {
            return Outcome::Started { stopped: false };
        };
        let due = Instant::now() + after;
        while Instant::now() < due {
            let view = self.snapshot().view;
            // Already stopped, or a different run: leave it alone.
            if view.operation.as_deref() != Some(operation.as_str())
                || view.phase != Phase::Listening
            {
                return Outcome::Started { stopped: false };
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
        Outcome::Started { stopped }
    }
}
