//! Development cue backend: the Claude Code CLI on the person's own Claude
//! subscription. For the owner's own use and the lab only; a shipped product
//! cannot share one subscription (see docs/product-readiness.md).
//!
//! Every text and setting comes from `scripts/fixtures/cue-decision.json`,
//! the file the lab reads too, so the app and the lab cannot drift. Nothing
//! runs until the engine submits a request, which it does only after the
//! person has turned the connection on. The first request also checks the
//! CLI's version and sign-in. There is no retry, no fallback model and no API
//! path; a failure is reported as a fixed code and the raw output is dropped.
use crate::cue_evaluator::{Cancellation, Evaluator, Failure, Request};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

const CONTRACT: &str = include_str!("../../scripts/fixtures/cue-decision.json");

/// Each request's deadline. One reply over it is skipped; two in a row stop
/// cues for the session (`TIMEOUTS_TO_STOP`).
pub const DEADLINE: Duration = Duration::from_secs(8);
/// The shortest time between two requests, on the session clock.
pub const MIN_GAP_MS: u64 = 2_000;

/// What the review screen says before anything is sent.
pub const DATA_POLICY: &str = "Sends to Anthropic, through Claude Code on this Mac and your own \
Claude subscription: up to six recent transcript lines and any lines the cue on screen cites, \
the cue on screen, up to four earlier cues with how each ended, and your session name if you set \
one. It sends after each new line, at most once every two seconds and one request at a time, \
until you turn this off, stop the session, or a failure stops it, so over a session nearly every \
transcript line is sent, a few at a time. It never sends audio, the \
full transcript, your notes, imported notes or focus lines. Anthropic handles what is sent under \
your Claude account's terms and settings, and lines already sent cannot be recalled. A \
development connection for the owner's own use; it is not a supported product feature.";

/// What the review screen says when the development settings name an
/// option this build does not have.
const MISCONFIGURED_POLICY: &str = "TALKQTE_CUE_MODEL or TALKQTE_CUE_EFFORT names an option \
this build does not have, so nothing can be sent. Use opus-5.5 or haiku-5.5, and low or medium.";

/// The engine for a new live session with this backend registered. It sends
/// nothing until the person reviews and turns the connection on. Unknown
/// development settings leave it unusable, with that reason shown, rather
/// than silently reaching another model or none.
pub fn connected_engine() -> crate::engine::Engine {
    use crate::engine::{ProcessingLocation, ProcessorConfiguration, ProcessorDisclosure};
    install_signal_cleanup();
    let processor = |model: String, effort: &str, policy: &str| {
        ProcessorConfiguration::new(
            "claude-cli".into(),
            1,
            model,
            ProcessingLocation::Hosted {
                service: "Anthropic, through Claude Code on this Mac".into(),
            },
            format!("cue-model-2026-11-14:{effort}"),
            ProcessorDisclosure::new("Claude (development connection)".into(), policy.into())
                .expect("fixed disclosure text is valid"),
        )
        .expect("fixed processor configuration is valid")
        .with_effort(effort.into())
        .without_notes()
    };
    match Choice::from_environment() {
        Ok(choice) => {
            let config = processor(choice.model_id.clone(), &choice.effort.clone(), DATA_POLICY);
            let worker = crate::cue_evaluator::Worker::start(
                ClaudeCli::new(
                    None,
                    choice,
                    std::env::vars_os()
                        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
                ),
                DEADLINE,
            )
            .expect("the deadline is within the worker's ceiling");
            crate::engine::Engine::live_with_evaluator(worker, config).with_min_gap_ms(MIN_GAP_MS)
        }
        Err(_) => {
            struct Refuse;
            impl Evaluator for Refuse {
                fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
                    Err(Failure::EvaluatorUnavailable)
                }
            }
            let worker = crate::cue_evaluator::Worker::start(Refuse, DEADLINE)
                .expect("the deadline is within the worker's ceiling");
            crate::engine::Engine::live_with_evaluator(
                worker,
                processor("unknown".into(), "unknown", MISCONFIGURED_POLICY),
            )
            .misconfigured()
        }
    }
}

// Process groups of calls in flight, so quitting or a signal can end them.
// Plain atomics, so the signal handler below only does what is safe there.
const SLOTS: usize = 8;
static GROUPS: [std::sync::atomic::AtomicI32; SLOTS] =
    [const { std::sync::atomic::AtomicI32::new(0) }; SLOTS];

fn track(pid: i32) -> Option<usize> {
    use std::sync::atomic::Ordering;
    (0..SLOTS).find(|&slot| {
        GROUPS[slot]
            .compare_exchange(0, pid, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    })
}

fn kill_group(pid: i32) {
    #[cfg(unix)]
    // SAFETY: signals only a process group this backend created.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

/// Ends every call still in flight and any helper it started. Called when
/// the app quits, and from the signal handler.
pub fn end_all() {
    for slot in &GROUPS {
        let pid = slot.swap(0, std::sync::atomic::Ordering::AcqRel);
        if pid > 0 {
            kill_group(pid);
        }
    }
}

/// On Ctrl-C, a terminal hang-up or a polite kill, end the calls in flight
/// before the app goes. Each call runs in its own process group, so it would
/// not receive the terminal's signal itself.
fn install_signal_cleanup() {
    #[cfg(unix)]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        extern "C" fn on_signal(signal: libc::c_int) {
            end_all();
            // SAFETY: restore the default action and re-raise, so the app
            // exits as it would have; both calls are async-signal-safe.
            unsafe {
                libc::signal(signal, libc::SIG_DFL);
                libc::raise(signal);
            }
        }
        ONCE.call_once(|| {
            for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
                // SAFETY: the handler only uses atomics and kill/signal/raise.
                unsafe {
                    libc::signal(signal, on_signal as *const () as libc::sighandler_t);
                }
            }
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    prompts: Prompts,
    models: BTreeMap<String, String>,
    default_model: String,
    efforts: Vec<String>,
    default_effort: String,
    min_cli_version: [u64; 3],
    cli: Cli,
    child_environment: ChildEnvironment,
    credential_pattern: Pattern,
    subscription: Subscription,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prompts {
    compact: String,
    glance_rule: String,
    name_note: String,
    history_note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cli {
    command: String,
    base_args: Vec<String>,
    version_args: Vec<String>,
    auth_status_args: Vec<String>,
    evaluate_args: Vec<String>,
    settings: serde_json::Value,
    max_output_bytes: usize,
}

#[derive(Deserialize)]
struct ChildEnvironment {
    allow: Vec<String>,
    set: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Pattern {
    source: String,
    flags: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    auth_method: String,
    api_provider: String,
    subscription_types: Vec<String>,
}

fn contract() -> Contract {
    serde_json::from_str(CONTRACT).expect("the shared cue decision file is valid")
}

/// The model and effort for a connection, chosen from the shared file's
/// options. Anything else is refused, so a mistyped name cannot reach
/// another model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    /// The short name, such as "opus-5.5".
    pub model: String,
    /// The model identifier sent to the CLI.
    pub model_id: String,
    pub effort: String,
}

impl Choice {
    pub fn new(model: Option<&str>, effort: Option<&str>) -> Result<Self, String> {
        let contract = contract();
        let model = model.unwrap_or(&contract.default_model).to_string();
        let effort = effort.unwrap_or(&contract.default_effort).to_string();
        let Some(model_id) = contract.models.get(&model).cloned() else {
            return Err(format!(
                "The model is one of: {}.",
                contract
                    .models
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        };
        if !contract.efforts.contains(&effort) {
            return Err(format!(
                "The effort is one of: {}.",
                contract.efforts.join(", ")
            ));
        }
        Ok(Self {
            model,
            model_id,
            effort,
        })
    }

    /// From `TALKQTE_CUE_MODEL` and `TALKQTE_CUE_EFFORT`, the development
    /// settings, or the shared file's defaults.
    pub fn from_environment() -> Result<Self, String> {
        Self::new(
            std::env::var("TALKQTE_CUE_MODEL").ok().as_deref(),
            std::env::var("TALKQTE_CUE_EFFORT").ok().as_deref(),
        )
    }
}

/// Names, never values, of inherited settings that could route a request to
/// an API key, another provider, a gateway, a proxy or another sign-in.
pub fn inherited_credentials<'a>(names: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<String> {
    let contract = contract();
    let pattern = regex::RegexBuilder::new(&contract.credential_pattern.source)
        .case_insensitive(contract.credential_pattern.flags.contains('i'))
        .build()
        .expect("the shared credential pattern compiles");
    let mut found: Vec<String> = names
        .filter(|(name, value)| !value.is_empty() && pattern.is_match(name))
        .map(|(name, _)| name.to_string())
        .collect();
    found.sort();
    found
}

/// The system prompt for a request: the compact prompt, the glance rule, and
/// the name and history sentences only when the request carries them.
pub fn system_prompt(request: &Request) -> String {
    let prompts = contract().prompts;
    let mut prompt = prompts.compact + &prompts.glance_rule;
    if request.user_name().is_some() {
        prompt += &prompts.name_note;
    }
    if !request.earlier_cues().is_empty() {
        prompt += &prompts.history_note;
    }
    prompt
}

/// The evaluation arguments, with the placeholders filled in.
pub fn evaluate_args(choice: &Choice, system_prompt: &str) -> Vec<String> {
    let contract = contract();
    let mut settings = contract.cli.settings.clone();
    fill_model(&mut settings, &choice.model_id);
    let settings = settings.to_string();
    contract
        .cli
        .base_args
        .iter()
        .cloned()
        .chain(
            contract
                .cli
                .evaluate_args
                .iter()
                .map(|arg| match arg.as_str() {
                    "{model}" => choice.model_id.clone(),
                    "{effort}" => choice.effort.clone(),
                    "{settings}" => settings.clone(),
                    "{systemPrompt}" => system_prompt.to_string(),
                    other => other.to_string(),
                }),
        )
        .collect()
}

fn fill_model(value: &mut serde_json::Value, model: &str) {
    match value {
        serde_json::Value::String(text) if text == "{model}" => *text = model.to_string(),
        serde_json::Value::Array(items) => items.iter_mut().for_each(|v| fill_model(v, model)),
        serde_json::Value::Object(map) => map.values_mut().for_each(|v| fill_model(v, model)),
        _ => {}
    }
}

/// Sorts a failed call into a fixed code from the CLI's own wording, the
/// same kinds the lab uses. The text is read once here and dropped: it can
/// hold account details.
pub fn classify(text: &str) -> Failure {
    let words = text.to_lowercase();
    // Status codes count only as whole words, as in the lab's patterns.
    let code = |code: &str| {
        regex::Regex::new(&format!(r"\b{code}\b"))
            .expect("a status-code pattern compiles")
            .is_match(&words)
    };
    let any = |list: &[&str]| list.iter().any(|w| words.contains(w));
    if any(&[
        "usage limit",
        "rate limit",
        "limit reached",
        "hit your limit",
        "quota",
        "too many requests",
        "out of usage",
        "out of extra usage",
        "credit balance",
    ]) || code("429")
    {
        Failure::UsageLimit
    } else if any(&[
        "not logged in",
        "please log in",
        "/login",
        "unauthorized",
        "unauthorised",
        "authenticat",
        "invalid api key",
        "credential",
        "oauth",
        "forbidden",
    ]) || code("401")
        || code("403")
    {
        Failure::SignIn
    } else {
        Failure::Unreachable
    }
}

/// A new empty folder, removed when dropped.
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tempdir() -> Result<TempDir, Failure> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "talkqte-cue-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&path).map_err(|_| Failure::Unreachable)?;
    Ok(TempDir(path))
}

/// What one finished child process returned.
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

/// The backend. One instance runs on the evaluator worker thread.
pub struct ClaudeCli {
    command: PathBuf,
    choice: Choice,
    environment: Vec<(String, String)>,
    checked: bool,
}

impl ClaudeCli {
    /// A backend that starts `command` with the given environment. The app
    /// passes the process environment; tests pass a fake CLI. Inherited
    /// credentials are checked here, before anything can run.
    pub fn new(
        command: Option<PathBuf>,
        choice: Choice,
        environment: impl Iterator<Item = (String, String)>,
    ) -> Self {
        Self {
            command: command.unwrap_or_else(|| contract().cli.command.into()),
            choice,
            environment: environment.collect(),
            checked: false,
        }
    }

    fn child_environment(&self) -> Vec<(String, String)> {
        let env = contract().child_environment;
        self.environment
            .iter()
            .filter(|(name, _)| env.allow.contains(name))
            .cloned()
            .chain(env.set)
            .collect()
    }

    fn run(&self, args: &[String], input: &str, cancel: &Cancellation) -> Result<Output, Failure> {
        let limit = contract().cli.max_output_bytes;
        // A fresh, empty folder for each call, as the lab uses, so no stray
        // CLAUDE.md or settings in a shared folder can reach the CLI.
        let workdir = tempdir()?;
        let mut command = Command::new(&self.command);
        command
            .args(args)
            .env_clear()
            .envs(self.child_environment())
            .current_dir(&workdir.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Its own process group, so ending a call also ends any helper it
        // started (a version-manager shim, for example).
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Failure::SignIn
            } else {
                Failure::Unreachable
            }
        })?;
        let pid = i32::try_from(child.id()).unwrap_or(0);
        let slot = (pid > 0).then(|| track(pid)).flatten();
        let release = move || {
            if let Some(slot) = slot {
                let _ = GROUPS[slot].compare_exchange(
                    pid,
                    0,
                    std::sync::atomic::Ordering::AcqRel,
                    std::sync::atomic::Ordering::Acquire,
                );
            }
        };
        let end = |child: &mut std::process::Child| {
            if pid > 0 {
                kill_group(pid);
            }
            let _ = child.kill();
            let _ = child.wait();
            release();
        };
        let mut stdin = child.stdin.take().expect("stdin piped");
        let input = input.to_string();
        // A child that exits early closes its stdin; that is reported below.
        thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
        let read = |mut pipe: Box<dyn Read + Send>| {
            let (done, result) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let mut out = Vec::new();
                let mut chunk = [0u8; 8192];
                let complete = loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => break true,
                        Ok(n) if out.len() + n > limit => break false,
                        Ok(n) => out.extend_from_slice(&chunk[..n]),
                    }
                };
                let _ = done.send(complete.then_some(out));
            });
            result
        };
        let stdout = read(Box::new(child.stdout.take().expect("stdout piped")));
        let stderr = read(Box::new(child.stderr.take().expect("stderr piped")));
        let status = loop {
            if cancel.is_cancelled() {
                // End a slow or cancelled call so it cannot hold the worker.
                end(&mut child);
                return Err(Failure::Cancelled);
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => {
                    end(&mut child);
                    return Err(Failure::Unreachable);
                }
            }
        };
        // The call is done: end any helper it left behind, which would also
        // keep its output open. Then the output can be read to its end.
        if pid > 0 {
            kill_group(pid);
        }
        release();
        // Wait for the output only while the call is still current.
        let mut collect = |pipe: std::sync::mpsc::Receiver<Option<Vec<u8>>>| loop {
            match pipe.recv_timeout(Duration::from_millis(20)) {
                Ok(out) => return Ok(out),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if cancel.is_cancelled() => {
                    end(&mut child);
                    return Err(Failure::Cancelled);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
        };
        let stdout = collect(stdout)?.ok_or(Failure::InvalidDecision)?;
        let stderr = collect(stderr)?.unwrap_or_default();
        Ok(Output {
            success: status.success(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// The version and sign-in checks, once per connection, before the first
    /// request is sent.
    fn preflight(&mut self, cancel: &Cancellation) -> Result<(), Failure> {
        let contract = contract();
        if !inherited_credentials(
            self.environment
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str())),
        )
        .is_empty()
        {
            return Err(Failure::Credentials);
        }
        let version = self.run(&contract.cli.version_args, "", cancel)?;
        // The version is the first word, as the lab reads it.
        let found: Vec<u64> = version
            .stdout
            .split_whitespace()
            .next()
            .filter(|word| word.matches('.').count() == 2)
            .map(|word| word.split('.').filter_map(|n| n.parse().ok()).collect())
            .unwrap_or_default();
        if !version.success || found.len() != 3 || found[..] < contract.min_cli_version[..] {
            return Err(Failure::SignIn);
        }
        let args: Vec<String> = contract
            .cli
            .base_args
            .iter()
            .chain(&contract.cli.auth_status_args)
            .cloned()
            .collect();
        let status = self.run(&args, "", cancel)?;
        let value: serde_json::Value =
            serde_json::from_str(&status.stdout).map_err(|_| Failure::SignIn)?;
        let sub = &contract.subscription;
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or("");
        if value.get("loggedIn") != Some(&serde_json::Value::Bool(true))
            || text("authMethod") != sub.auth_method
            || text("apiProvider") != sub.api_provider
            || !sub
                .subscription_types
                .iter()
                .any(|kind| kind == text("subscriptionType"))
        {
            return Err(Failure::SignIn);
        }
        self.checked = true;
        Ok(())
    }
}

impl Evaluator for ClaudeCli {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        // Checked before any process starts, on every request.
        if !inherited_credentials(
            self.environment
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str())),
        )
        .is_empty()
        {
            return Err(Failure::Credentials);
        }
        let input = request.prompt_input()?;
        if !self.checked {
            self.preflight(cancel)?;
        }
        let args = evaluate_args(&self.choice, &system_prompt(request));
        let output = self.run(&args, &input, cancel)?;
        // Any non-zero exit fails, as in the lab, sorted by the CLI's wording.
        if !output.success {
            return Err(classify(&format!("{}\n{}", output.stdout, output.stderr)));
        }
        let wrapper: serde_json::Value =
            serde_json::from_str(&output.stdout).map_err(|_| Failure::InvalidDecision)?;
        let text = |key: &str| wrapper.get(key).and_then(|v| v.as_str()).unwrap_or("");
        if text("type") != "result"
            || text("subtype") != "success"
            || wrapper.get("is_error") != Some(&serde_json::Value::Bool(false))
        {
            return Err(classify(&format!(
                "{}\n{}\n{}",
                text("subtype"),
                text("result"),
                output.stderr
            )));
        }
        // Only the requested model may have answered.
        let models: Vec<&String> = wrapper
            .get("modelUsage")
            .and_then(|v| v.as_object())
            .map(|usage| usage.keys().collect())
            .unwrap_or_default();
        if models.len() != 1 || *models[0] != self.choice.model_id {
            return Err(Failure::InvalidDecision);
        }
        wrapper
            .get("result")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or(Failure::InvalidDecision)
    }
}

#[cfg(all(test, unix))]
mod tests {
    //! A fake `claude` executable stands in for the CLI: no model is called.
    use super::*;
    use crate::cue_evaluator::{
        CueEnd, EarlierCue, ExistingCue, Provenance, Source, Worker, MAX_BUDGET,
    };
    use std::{os::unix::fs::PermissionsExt, path::Path};

    const SUBSCRIBED: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}"#;

    fn line(id: &str, text: &str) -> Source {
        Source {
            id: id.into(),
            revision: 1,
            provenance: Provenance::Transcript {
                at_ms: 1_000,
                speaker: "Maya".into(),
            },
            text: text.into(),
        }
    }

    fn request() -> Request {
        Request::new(
            7,
            1,
            vec![
                line("transcript:a", "Someone should book the hall."),
                line("transcript:b", "The hall is free on Saturday."),
            ],
            None,
        )
        .unwrap()
    }

    /// Writes a fake CLI that answers `--version`, `auth status` and an
    /// evaluation, recording its arguments and input beside itself.
    fn fake(dir: &Path, auth: &str, evaluation: &str) -> PathBuf {
        let path = dir.join("claude");
        let script = format!(
            "#!/bin/sh\n\
             case \"$*\" in\n\
             *--version*) echo '2.1.318 (Claude Code)' ;;\n\
             *'auth status'*) echo '{auth}' ;;\n\
             *--print*) printf '%s\\n' \"$@\" > \"{dir}/args\"; env > \"{dir}/env\"; cat > \"{dir}/input\"; {evaluation} ;;\n\
             esac\n",
            dir = dir.display()
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn wrapper(model: &str, result: &str) -> String {
        let value = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": result, "modelUsage": { model: {} },
        });
        format!("echo '{}'", value.to_string().replace('\'', "'\\''"))
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "talkqte-claude-cli-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backend(path: PathBuf, environment: &[(&str, &str)]) -> ClaudeCli {
        ClaudeCli::new(
            Some(path),
            Choice::new(None, None).unwrap(),
            environment
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string())),
        )
    }

    fn evaluate(
        cli: ClaudeCli,
        request: &Request,
    ) -> Result<crate::cue_evaluator::Decision, Failure> {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let mut worker = Worker::start(cli, MAX_BUDGET).unwrap();
        worker.submit(request.clone()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(result) = worker.poll(request) {
                return result;
            }
            assert!(std::time::Instant::now() < until, "fake CLI did not finish");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_compact_reply_from_the_requested_model_becomes_a_decision() {
        let dir = temp();
        let reply =
            r#"{"action":"show","cue":"Who will book the hall?","sourceIds":["transcript:a"]}"#;
        let path = fake(&dir, SUBSCRIBED, &wrapper("claude-opus-5-5", reply));
        let request = request()
            .with_listener(
                Some("Robin".into()),
                vec![EarlierCue {
                    text: "Who will send the flyer?".into(),
                    state: CueEnd::Resolved,
                }],
            )
            .unwrap();
        let decision = evaluate(
            backend(path, &[("HOME", "/tmp"), ("PATH", "/bin:/usr/bin")]),
            &request,
        )
        .unwrap();
        assert_eq!(decision.cue.as_deref(), Some("Who will book the hall?"));
        // The input is the lab's app-style request, field for field.
        assert_eq!(
            std::fs::read_to_string(dir.join("input")).unwrap(),
            r#"{"events":[{"id":"transcript:a","speaker":"Speaker","text":"Someone should book the hall."},{"id":"transcript:b","speaker":"Speaker","text":"The hall is free on Saturday."}],"existingCue":null,"userName":"Robin","earlierCues":[{"text":"Who will send the flyer?","state":"resolved"}]}"#
        );
        // The arguments are the shared file's, with the placeholders filled.
        let args = std::fs::read_to_string(dir.join("args")).unwrap();
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(
            &args[..4],
            ["--safe-mode", "--restricted", "--setting-sources", ""]
        );
        let at = |flag: &str| args[args.iter().position(|a| *a == flag).unwrap() + 1];
        assert_eq!(at("--model"), "claude-opus-5-5");
        assert_eq!(at("--effort"), "medium");
        assert!(at("--settings").contains(r#""availableModels":["claude-opus-5-5"]"#));
        assert!(at("--settings").contains(r#""switchModelsOnFlag":false"#));
        let prompt =
            args[args.iter().position(|a| *a == "--system-prompt").unwrap() + 1..].join("\n");
        assert!(prompt.starts_with("You evaluate one fictional conversation for TalkQTE."));
        assert!(prompt.contains("userName is the listener's own name"));
        assert!(prompt.contains("earlierCues lists cues already shown"));
        assert!(prompt.contains("at most 10 words"));
        // Only the allowed environment, plus the fixed settings, reaches it.
        let env = std::fs::read_to_string(dir.join("env")).unwrap();
        assert!(env.contains("CLAUDE_CODE_MAX_RETRIES=0"));
        assert!(env.contains("HOME=/tmp"));
    }

    #[test]
    fn inherited_credentials_are_refused_before_anything_runs() {
        let dir = temp();
        let path = fake(&dir, SUBSCRIBED, "echo never");
        for name in [
            "ANTHROPIC_API_KEY",
            "anthropic_base_url",
            "HTTPS_PROXY",
            "CLAUDE_CODE_USE_BEDROCK",
        ] {
            let result = evaluate(backend(path.clone(), &[(name, "set")]), &request());
            assert_eq!(result, Err(Failure::Credentials), "{name}");
        }
        assert!(!dir.join("input").exists(), "the CLI was started");
        // An empty value and ordinary names are not credentials.
        assert!(
            inherited_credentials([("ANTHROPIC_API_KEY", ""), ("HOME", "/x")].into_iter())
                .is_empty()
        );
    }

    #[test]
    fn sign_in_version_and_model_checks_refuse_before_a_cue() {
        let reply = r#"{"action":"quiet","cue":null,"sourceIds":["transcript:a"]}"#;
        let api_key_login = r#"{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","subscriptionType":null}"#;
        for (auth, evaluation, expected) in [
            (api_key_login, wrapper("claude-opus-5-5", reply), Failure::SignIn),
            (r#"{"loggedIn":false}"#, wrapper("claude-opus-5-5", reply), Failure::SignIn),
            // A reply from another model is not accepted.
            (SUBSCRIBED, wrapper("claude-haiku-5-5", reply), Failure::InvalidDecision),
            // The lab's full reply is not the app's compact one.
            (
                SUBSCRIBED,
                wrapper(
                    "claude-opus-5-5",
                    r#"{"action":"quiet","cue":null,"sourceIds":["transcript:a"],"reason":"x","observedUse":"not_observed"}"#,
                ),
                Failure::InvalidDecision,
            ),
            // The CLI's own error wording is sorted, then dropped.
            (
                SUBSCRIBED,
                r#"echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You have hit your limit"}'"#.into(),
                Failure::UsageLimit,
            ),
            (SUBSCRIBED, "echo 'Please log in' >&2; exit 1".into(), Failure::SignIn),
            (SUBSCRIBED, "echo 'ENOTFOUND api' >&2; exit 1".into(), Failure::Unreachable),
        ] {
            let dir = temp();
            let path = fake(&dir, auth, &evaluation);
            assert_eq!(evaluate(backend(path, &[]), &request()), Err(expected), "{evaluation}");
        }
        let missing = temp().join("no-such-claude");
        assert_eq!(
            evaluate(backend(missing, &[]), &request()),
            Err(Failure::SignIn)
        );
    }

    #[test]
    fn status_codes_count_only_as_whole_words_and_a_failed_exit_is_refused() {
        assert_eq!(classify("request id 40130 failed"), Failure::Unreachable);
        assert_eq!(classify("HTTP 429 Too Many"), Failure::UsageLimit);
        assert_eq!(classify("error 401"), Failure::SignIn);
        // Valid JSON on standard output does not rescue a non-zero exit.
        let dir = temp();
        let reply = r#"{"action":"quiet","cue":null,"sourceIds":["transcript:a"]}"#;
        let path = fake(
            &dir,
            SUBSCRIBED,
            &format!("{}; exit 1", wrapper("claude-opus-5-5", reply)),
        );
        assert_eq!(
            evaluate(backend(path, &[]), &request()),
            Err(Failure::Unreachable)
        );
    }

    // Tests that start long-running fake calls, or end every call, run one
    // at a time so `end_all` cannot reach another test's call.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn a_too_old_cli_and_unlisted_environment_never_reach_a_call() {
        let dir = temp();
        let path = dir.join("claude");
        std::fs::write(
            &path,
            "#!/bin/sh\ncase \"$*\" in *--version*) echo '2.1.300 (Claude Code)' ;; *) env > \"$(dirname \"$0\")/env\" ;; esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            evaluate(backend(path, &[]), &request()),
            Err(Failure::SignIn)
        );
        // A name outside the allowlist never reaches the CLI's environment.
        let dir = temp();
        let reply = r#"{"action":"quiet","cue":null,"sourceIds":["transcript:a"]}"#;
        let path = fake(&dir, SUBSCRIBED, &wrapper("claude-opus-5-5", reply));
        evaluate(
            backend(
                path,
                &[
                    ("HOME", "/tmp"),
                    ("SECRET_PROJECT_TOKEN", "x"),
                    ("GIT_DIR", "/x"),
                ],
            ),
            &request(),
        )
        .unwrap();
        let env = std::fs::read_to_string(dir.join("env")).unwrap();
        assert!(!env.contains("SECRET_PROJECT_TOKEN") && !env.contains("GIT_DIR"));
    }

    #[test]
    fn the_review_text_names_exactly_what_a_request_carries() {
        let request = request()
            .with_listener(
                Some("Robin".into()),
                vec![EarlierCue {
                    text: "Who will send the flyer?".into(),
                    state: CueEnd::Expired,
                }],
            )
            .unwrap();
        let input: serde_json::Value =
            serde_json::from_str(&request.prompt_input().unwrap()).unwrap();
        let keys: Vec<&String> = input.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 4);
        for (key, said) in [
            ("events", "recent transcript lines"),
            ("existingCue", "the cue on screen"),
            ("userName", "your session name"),
            ("earlierCues", "earlier cues with how each ended"),
        ] {
            assert!(input.get(key).is_some(), "{key}");
            assert!(DATA_POLICY.contains(said), "the review does not say {said}");
        }
        for event in input["events"].as_array().unwrap() {
            let fields: Vec<&String> = event.as_object().unwrap().keys().collect();
            assert_eq!(fields.len(), 3, "a line carries only id, speaker and text");
        }
        for never in [
            "audio",
            "full transcript",
            "your notes",
            "imported notes",
            "focus lines",
        ] {
            assert!(DATA_POLICY.contains(never), "{never}");
        }
    }

    #[test]
    fn helpers_left_by_a_call_are_ended_when_it_finishes() {
        let dir = temp();
        let reply = r#"{"action":"quiet","cue":null,"sourceIds":["transcript:a"]}"#;
        let path = fake(
            &dir,
            SUBSCRIBED,
            &format!(
                "sleep 30 & echo $! > \"{}/helper\"; {}",
                dir.display(),
                wrapper("claude-opus-5-5", reply)
            ),
        );
        // The helper keeps the output open, yet the reply arrives in time.
        let started = std::time::Instant::now();
        evaluate(backend(path, &[]), &request()).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        let helper: i32 = std::fs::read_to_string(dir.join("helper"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(!alive(helper), "the helper outlived its call");
    }

    #[test]
    fn quitting_ends_a_call_in_flight() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp();
        let path = fake(&dir, SUBSCRIBED, "sleep 30");
        let request = request();
        let mut worker = Worker::start(backend(path, &[]), MAX_BUDGET).unwrap();
        worker.submit(request.clone()).unwrap();
        // Wait for the call itself to start, after the checks.
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !dir.join("input").exists() {
            assert!(std::time::Instant::now() < until, "the call never started");
            thread::sleep(Duration::from_millis(10));
        }
        let started = std::time::Instant::now();
        end_all();
        // The ended call reports back long before its 30-second sleep.
        while worker.poll(&request).is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the call ran on"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_slow_call_is_ended_at_the_deadline() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp();
        let path = fake(&dir, SUBSCRIBED, "sleep 30");
        let request = request();
        let mut worker = Worker::start(backend(path, &[]), Duration::from_millis(300)).unwrap();
        worker.submit(request.clone()).unwrap();
        let started = std::time::Instant::now();
        let result = loop {
            if let Some(result) = worker.poll(&request) {
                break result;
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(result, Err(Failure::Expired));
        // The child was killed, so the worker is free again well before 30 s.
        while worker.is_busy() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "child kept the worker"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn prior_notes_and_a_cue_on_screen_are_handled_as_the_lab_sends_them() {
        let cue = ExistingCue {
            id: "c1".into(),
            text: "Who will book the hall?".into(),
            source_ids: vec!["transcript:a".into()],
        };
        let with_cue =
            Request::new(7, 1, vec![line("transcript:a", "Book it.")], Some(cue)).unwrap();
        assert_eq!(
            with_cue.prompt_input().unwrap(),
            r#"{"events":[{"id":"transcript:a","speaker":"Speaker","text":"Book it."}],"existingCue":{"text":"Who will book the hall?","sourceIds":["transcript:a"]}}"#
        );
        let note = Source {
            id: "prior:file:one".into(),
            revision: 1,
            provenance: Provenance::PriorNote {
                provider: crate::context::Provider::File,
                date: "2026-11-01".into(),
                title: "Earlier".into(),
            },
            text: "A prior note.".into(),
        };
        let with_note =
            Request::new(7, 1, vec![line("transcript:a", "Book it."), note], None).unwrap();
        assert_eq!(with_note.prompt_input(), Err(Failure::InvalidInput));
        // Unknown models and efforts are refused by name.
        assert!(Choice::new(Some("gpt"), None).is_err());
        assert!(Choice::new(None, Some("high")).is_err());
        assert_eq!(
            Choice::new(Some("haiku-5.5"), Some("low"))
                .unwrap()
                .model_id,
            "claude-haiku-5-5"
        );
    }
}
