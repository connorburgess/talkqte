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
until you turn this off, stop the session, or a failure stops it. It never sends audio, the \
full transcript, your notes, imported notes or focus lines. Anthropic handles what is sent under \
your Claude account's terms and settings, and lines already sent cannot be recalled. A \
development connection for the owner's own use; it is not a supported product feature.";

/// The engine for a new live session. With the `claude-cli` feature it
/// registers this backend, which sends nothing until the person reviews and
/// turns the connection on; otherwise, and if the development settings name
/// an unknown model or effort, it is the plain engine with no cue backend.
pub fn live_engine() -> crate::engine::Engine {
    #[cfg(feature = "claude-cli")]
    if let Some(engine) = connected_engine() {
        return engine;
    }
    crate::engine::Engine::live()
}

#[cfg(feature = "claude-cli")]
fn connected_engine() -> Option<crate::engine::Engine> {
    use crate::engine::{ProcessingLocation, ProcessorConfiguration, ProcessorDisclosure};
    let choice = Choice::from_environment().ok()?;
    let processor = ProcessorConfiguration::new(
        "claude-cli".into(),
        1,
        choice.model_id.clone(),
        ProcessingLocation::Hosted {
            service: "Anthropic, through Claude Code on this Mac".into(),
        },
        format!("cue-model-2026-11-14:{}", choice.effort),
        ProcessorDisclosure::new("Claude (development connection)".into(), DATA_POLICY.into())
            .ok()?,
    )
    .ok()?
    .with_effort(choice.effort.clone());
    let worker = crate::cue_evaluator::Worker::start(
        ClaudeCli::new(None, choice, std::env::vars()),
        DEADLINE,
    )
    .ok()?;
    Some(crate::engine::Engine::live_with_evaluator(worker, processor).with_min_gap_ms(MIN_GAP_MS))
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
    let any = |list: &[&str]| list.iter().any(|w| words.contains(w));
    if any(&[
        "usage limit",
        "rate limit",
        "limit reached",
        "hit your limit",
        "quota",
        "too many requests",
        "429",
        "out of usage",
        "out of extra usage",
        "credit balance",
    ]) {
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
        "401",
        "403",
        "forbidden",
    ]) {
        Failure::SignIn
    } else {
        Failure::Unreachable
    }
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
        let workdir = std::env::temp_dir();
        let mut child = Command::new(&self.command)
            .args(args)
            .env_clear()
            .envs(self.child_environment())
            .current_dir(workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Failure::SignIn
                } else {
                    Failure::Unreachable
                }
            })?;
        let mut stdin = child.stdin.take().expect("stdin piped");
        let input = input.to_string();
        // A child that exits early closes its stdin; that is reported below.
        let writer = thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
        let read = |mut pipe: Box<dyn Read + Send>| {
            thread::spawn(move || {
                let mut out = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if out.len() + n > limit {
                                return None;
                            }
                            out.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
                Some(out)
            })
        };
        let stdout = read(Box::new(child.stdout.take().expect("stdout piped")));
        let stderr = read(Box::new(child.stderr.take().expect("stderr piped")));
        let status = loop {
            if cancel.is_cancelled() {
                // End a slow or cancelled call so it cannot hold the worker.
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Cancelled);
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => {
                    let _ = child.kill();
                    return Err(Failure::Unreachable);
                }
            }
        };
        let _ = writer.join();
        let stdout = stdout
            .join()
            .ok()
            .flatten()
            .ok_or(Failure::InvalidDecision)?;
        let stderr = stderr.join().ok().flatten().unwrap_or_default();
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
        let found: Vec<u64> = version
            .stdout
            .split(|c: char| !c.is_ascii_digit() && c != '.')
            .find(|part| part.matches('.').count() == 2)
            .map(|part| part.split('.').filter_map(|n| n.parse().ok()).collect())
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
        let wrapper: serde_json::Value = match serde_json::from_str(&output.stdout) {
            Ok(value) => value,
            Err(_) if !output.success => return Err(classify(&output.stderr)),
            Err(_) => return Err(Failure::InvalidDecision),
        };
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
    fn a_slow_call_is_ended_at_the_deadline() {
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
