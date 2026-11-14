//! Inert, development-only fictional lab client. Native activation is a
//! separate change. No CLI, capture handle, credential or cue-injection API.
#![cfg_attr(test, allow(dead_code))]
use crate::cue_evaluator::{
    Cancellation, EvaluationLifecycle, Evaluator, Failure, Request, Settlement, Worker,
};
use crate::engine::{
    CueSnapshot, Engine, ProcessingLocation, ProcessorConfiguration, ProcessorDisclosure,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

const SCHEMA: &str = "talkqte.lab.v1";
const FRAME_LIMIT: usize = 65_536;
const DEADLINE: Duration = Duration::from_secs(8);
const IO_SLICE: Duration = Duration::from_millis(20);
const SETTLEMENT_GRACE: Duration = Duration::from_secs(1);
const QUEUE: usize = 16;

#[derive(Clone, Copy)]
pub(crate) enum ControlReason {
    Stop,
    Pause,
    Revoke,
    Replace,
    Dismiss,
    Exit,
    EligibilityChange,
    PublicationFailed,
    TransportFailed,
}
impl ControlReason {
    fn wire(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Pause => "pause",
            Self::Revoke => "revoke",
            Self::Replace => "replace",
            Self::Dismiss => "dismiss",
            Self::Exit => "exit",
            Self::EligibilityChange => "eligibility_change",
            Self::PublicationFailed => "publication_failed",
            Self::TransportFailed => "transport_failed",
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) struct ClockSample {
    pub session_id: u64,
    pub elapsed_ms: u64,
}
pub(crate) type ClockSampler = Arc<dyn Fn() -> Option<ClockSample> + Send + Sync>;

#[derive(Clone)]
struct Settings {
    descriptor: PathBuf,
    provider: String,
    model: String,
    effort: String,
}
impl Settings {
    fn parse(mut get: impl FnMut(&str) -> Option<String>) -> Result<Self, Failure> {
        if get("TALKQTE_DEV_CUE_BACKEND").as_deref() != Some("lab-subscription") {
            return Err(Failure::InvalidInput);
        }
        let descriptor =
            PathBuf::from(get("TALKQTE_DEV_LAB_DESCRIPTOR").ok_or(Failure::InvalidInput)?);
        let provider = get("TALKQTE_DEV_LAB_PROVIDER").ok_or(Failure::InvalidInput)?;
        let model = get("TALKQTE_DEV_LAB_MODEL").ok_or(Failure::InvalidInput)?;
        let effort = get("TALKQTE_DEV_LAB_EFFORT").ok_or(Failure::InvalidInput)?;
        // Pinned per-run identities only. Fable is a separate owner decision.
        let valid_model = match provider.as_str() {
            "codex" => model == "gpt-6.1-sol",
            "claude-code" => matches!(model.as_str(), "claude-opus-5-5" | "claude-haiku-5-5"),
            _ => false,
        };
        if !descriptor.is_absolute() || !valid_model || !matches!(effort.as_str(), "low" | "medium")
        {
            return Err(Failure::InvalidInput);
        }
        Ok(Self {
            descriptor,
            provider,
            model,
            effort,
        })
    }
    fn label(&self) -> &'static str {
        if self.provider == "codex" {
            "Codex"
        } else {
            "Claude"
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    schema: String,
    run_id: String,
    socket_path: PathBuf,
    nonce: String,
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn descriptor(settings: &Settings) -> Result<Descriptor, Failure> {
    let parent = settings.descriptor.parent().ok_or(Failure::InvalidInput)?;
    let dir = fs::symlink_metadata(parent).map_err(|_| Failure::Unreachable)?;
    // SAFETY: geteuid has no arguments or side effects.
    let uid = unsafe { libc::geteuid() };
    if !dir.is_dir() || dir.uid() != uid || dir.mode() & 0o777 != 0o700 {
        return Err(Failure::Credentials);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&settings.descriptor)
        .map_err(|_| Failure::Credentials)?;
    let meta = file.metadata().map_err(|_| Failure::Credentials)?;
    if !meta.is_file() || meta.uid() != uid || meta.mode() & 0o777 != 0o600 || meta.len() > 4096 {
        return Err(Failure::Credentials);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Credentials)?;
    if bytes.len() > 4096 {
        return Err(Failure::Credentials);
    }
    let d: Descriptor = serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidInput)?;
    if d.schema != "talkqte.lab.descriptor.v1"
        || !identifier(&d.run_id)
        || d.nonce.len() != 64
        || !d
            .nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !d.socket_path.is_absolute()
        || d.socket_path.parent() != Some(parent)
    {
        return Err(Failure::InvalidInput);
    }
    let socket = fs::symlink_metadata(&d.socket_path).map_err(|_| Failure::Unreachable)?;
    if !socket.file_type().is_socket() || socket.uid() != uid || socket.mode() & 0o777 != 0o600 {
        return Err(Failure::Credentials);
    }
    Ok(d)
}
#[derive(Clone)]
struct Identity {
    session: u64,
    request: u64,
    context: u64,
}
impl Identity {
    fn add(&self, frame: &mut Value) {
        frame["requestId"] = json!(self.request.to_string());
        frame["contextRevision"] = json!(self.context.to_string());
    }
    fn matches(&self, v: &Value) -> bool {
        decimal_id(&v["requestId"], self.request) && decimal_id(&v["contextRevision"], self.context)
    }
}
struct Pending {
    request: Request,
    identity: Identity,
}
enum Event {
    Evaluate {
        identity: Identity,
        input: Value,
        until: Instant,
        reply: SyncSender<Result<String, Failure>>,
    },
    Settled(Identity, Settlement),
    Observation(Value),
}
struct Link {
    settings: Settings,
    tx: SyncSender<Event>,
    terminal: AtomicU8,
    reason: Mutex<ControlReason>,
    started: AtomicBool,
    next: AtomicU64,
    pending: Mutex<Option<Pending>>,
    sampler: Arc<Mutex<Option<ClockSampler>>>,
    observations: Mutex<Observations>,
    fault: Arc<AtomicBool>,
    session: AtomicU64,
}
fn failure_code(f: Failure) -> u8 {
    match f {
        Failure::SignIn => 2,
        Failure::Credentials => 3,
        Failure::UsageLimit => 4,
        Failure::InvalidDecision => 5,
        Failure::Expired => 6,
        _ => 1,
    }
}
fn failure_from(code: u8) -> Failure {
    match code {
        2 => Failure::SignIn,
        3 => Failure::Credentials,
        4 => Failure::UsageLimit,
        5 => Failure::InvalidDecision,
        6 => Failure::Expired,
        _ => Failure::WorkerUnavailable,
    }
}
impl Link {
    fn new(
        settings: Settings,
        sampler: Arc<Mutex<Option<ClockSampler>>>,
        fault: Arc<AtomicBool>,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let link = Arc::new(Self {
            settings,
            tx,
            terminal: AtomicU8::new(0),
            reason: Mutex::new(ControlReason::TransportFailed),
            started: AtomicBool::new(false),
            next: AtomicU64::new(0),
            pending: Mutex::new(None),
            sampler,
            observations: Mutex::new(Observations::default()),
            fault,
            session: AtomicU64::new(0),
        });
        // Inert thread: waits for first permission-gated evaluate before file/socket I/O.
        let weak = Arc::downgrade(&link);
        thread::spawn(move || {
            let Ok(first) = rx.recv() else {
                return;
            };
            let Some(link) = weak.upgrade() else {
                return;
            };
            if let Err(f) = transport(&link, rx, first) {
                link.fail(f);
            }
        });
        link
    }
    fn fail(&self, f: Failure) {
        if let Ok(mut pending) = self.pending.try_lock() {
            *pending = None;
        }
        let _ =
            self.terminal
                .compare_exchange(0, failure_code(f), Ordering::AcqRel, Ordering::Acquire);
    }
    fn send(&self, event: Event) -> Result<(), Failure> {
        self.tx.try_send(event).map_err(|_| {
            self.fail(Failure::WorkerUnavailable);
            Failure::WorkerUnavailable
        })
    }
    fn cancel_reason(&self, reason: ControlReason) {
        if self.terminal.load(Ordering::Acquire) != 0 {
            return;
        }
        if let Ok(mut slot) = self.reason.try_lock() {
            *slot = reason;
        }
        self.fail(Failure::WorkerUnavailable);
    }
    fn evaluate(&self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        if let Some(f) = self.terminal() {
            return Err(f);
        }
        let number = self
            .next
            .fetch_add(1, Ordering::AcqRel)
            .checked_add(1)
            .ok_or(Failure::WorkerUnavailable)?;
        let identity = Identity {
            session: request.session_id(),
            context: request.context_revision(),
            request: number,
        };
        let input =
            serde_json::from_str(&request.prompt_input()?).map_err(|_| Failure::InvalidInput)?;
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| Failure::WorkerUnavailable)?;
            if pending.is_some() {
                return Err(Failure::Busy);
            }
            *pending = Some(Pending {
                request: request.clone(),
                identity: identity.clone(),
            });
        }
        if let Some(f) = self.terminal() {
            if let Ok(mut pending) = self.pending.try_lock() {
                *pending = None;
            }
            return Err(f);
        }
        let (reply, rx) = mpsc::sync_channel(1);
        self.session.store(identity.session, Ordering::Release);
        self.started.store(true, Ordering::Release);
        self.send(Event::Evaluate {
            identity,
            input,
            until: cancel.deadline(),
            reply,
        })?;
        loop {
            if cancel.is_cancelled() {
                self.cancel_reason(ControlReason::TransportFailed);
                return Err(Failure::Cancelled);
            }
            if let Some(f) = self.terminal() {
                return Err(f);
            }
            match rx.recv_timeout(IO_SLICE) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => thread::sleep(IO_SLICE),
            }
        }
    }
    fn observe(&self, engine: &Engine, snapshot: &CueSnapshot, emitted: bool) {
        if !self.started.load(Ordering::Acquire) {
            return;
        }
        if engine.session() != self.session.load(Ordering::Acquire) {
            self.fail(Failure::InvalidDecision);
            return;
        }
        if !emitted {
            self.cancel_reason(ControlReason::PublicationFailed);
            return;
        }
        let Ok(mut observer) = self.observations.try_lock() else {
            self.fail(Failure::WorkerUnavailable);
            return;
        };
        if let Some(frame) = observer.observe(engine, snapshot) {
            let _ = self.send(Event::Observation(frame));
        }
    }
}
impl EvaluationLifecycle for Link {
    fn terminal(&self) -> Option<Failure> {
        if self.fault.load(Ordering::Acquire) {
            if let Ok(mut pending) = self.pending.try_lock() {
                *pending = None;
            }
            return Some(Failure::WorkerUnavailable);
        }
        match self.terminal.load(Ordering::Acquire) {
            0 => None,
            n => Some(failure_from(n)),
        }
    }
    fn cancel(&self) {
        self.cancel_reason(ControlReason::EligibilityChange);
    }
    fn settle(&self, request: &Request, verdict: Settlement) -> Result<(), Failure> {
        let mut pending = self.pending.try_lock().map_err(|_| {
            self.fail(Failure::WorkerUnavailable);
            Failure::WorkerUnavailable
        })?;
        let Some(p) = pending.take() else {
            self.fail(Failure::InvalidDecision);
            return Err(Failure::InvalidDecision);
        };
        if p.request != *request {
            self.fail(Failure::InvalidDecision);
            return Err(Failure::InvalidDecision);
        }
        self.send(Event::Settled(p.identity, verdict))
    }
}
struct Adapter(Arc<Link>);
impl Drop for Adapter {
    fn drop(&mut self) {
        self.0.cancel_reason(ControlReason::Exit);
    }
}
impl Evaluator for Adapter {
    fn evaluate(&mut self, r: &Request, c: &Cancellation) -> Result<String, Failure> {
        self.0.evaluate(r, c)
    }
}

#[derive(Default)]
struct Observations {
    session: Option<u64>,
    revision: Option<u64>,
    current: Option<(String, u64)>,
}
impl Observations {
    fn observe(&mut self, engine: &Engine, snapshot: &CueSnapshot) -> Option<Value> {
        let session = engine.session();
        if self.session == Some(session) && self.revision.is_some_and(|r| snapshot.revision <= r) {
            return None;
        }
        if self.session != Some(session) {
            self.current = None;
        }
        self.session = Some(session);
        self.revision = Some(snapshot.revision);
        let now = engine.state.elapsed_ms;
        let cue = snapshot
            .cue
            .as_ref()
            .filter(|c| !c.about_focus && c.note.is_none())
            .and_then(|c| engine.lab_cue_metadata(&c.id).map(|meta| (c, meta)));
        let next = cue.as_ref().map(|(c, _)| c.id.as_str());
        let cleared = self
            .current
            .as_ref()
            .filter(|(id, _)| Some(id.as_str()) != next)
            .map(|(id, _)| json!({"cueId":id,"clearedAtNativeMs":now}));
        let current=cue.map(|(c,(request,decision))| {
            let published=self.current.as_ref().filter(|(id,_)|*id==c.id).map_or(now,|(_,at)|*at);
            self.current=Some((c.id.clone(),published));
            json!({"cueId":c.id,"text":c.question,"kind":c.kind,"held":c.held,"resolved":c.resolved_by.is_some(),"decider":"model","requestId":request.to_string(),"decisionAtNativeMs":decision,"publishedAtNativeMs":published})
        });
        if current.is_none() {
            self.current = None;
        }
        Some(
            json!({"snapshotRevision":snapshot.revision.to_string(),"nativeSessionElapsedMs":now,"publicationSucceeded":true,"currentCue":current,"cleared":cleared.into_iter().collect::<Vec<_>>()}),
        )
    }
}

fn decimal_id(value: &Value, expected: u64) -> bool {
    value.as_str().is_some_and(|s| {
        s.bytes().all(|b| b.is_ascii_digit())
            && (s == "0" || !s.starts_with('0'))
            && s.parse::<u64>() == Ok(expected)
    })
}
fn frame(kind: &str, run: &str, session: u64) -> Value {
    json!({"schema":SCHEMA,"type":kind,"runId":run,"sessionId":session.to_string()})
}
fn write_frame(stream: &mut UnixStream, v: &Value) -> Result<(), Failure> {
    let mut bytes = serde_json::to_vec(v).map_err(|_| Failure::InvalidInput)?;
    if bytes.len() + 1 > FRAME_LIMIT {
        return Err(Failure::InvalidInput);
    }
    bytes.push(b'\n');
    // Bound the entire write, including a peer that accepts tiny fragments.
    // The socket's short write timeout also bounds each blocking syscall.
    let until = Instant::now() + Duration::from_millis(100);
    let mut written = 0;
    while written < bytes.len() {
        if Instant::now() >= until {
            return Err(Failure::Expired);
        }
        match stream.write(&bytes[written..]) {
            Ok(0) => return Err(Failure::Unreachable),
            Ok(n) => written += n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(Failure::Unreachable),
        }
    }
    Ok(())
}
#[derive(Default)]
struct Reader {
    bytes: Vec<u8>,
    partial_since: Option<Instant>,
}
impl Reader {
    fn read(&mut self, s: &mut UnixStream) -> Result<Option<Value>, Failure> {
        if self
            .partial_since
            .is_some_and(|at| at.elapsed() > Duration::from_secs(1))
        {
            return Err(Failure::Expired);
        }
        if let Some(at) = self.bytes.iter().position(|b| *b == b'\n') {
            let bytes: Vec<_> = self.bytes.drain(..=at).collect();
            self.partial_since = (!self.bytes.is_empty()).then(Instant::now);
            return serde_json::from_slice(&bytes[..at])
                .map(Some)
                .map_err(|_| Failure::InvalidDecision);
        }
        let mut block = [0u8; 4096];
        match s.read(&mut block) {
            Ok(0) => Err(Failure::Unreachable),
            Ok(n) => {
                if self.bytes.len() + n > FRAME_LIMIT {
                    return Err(Failure::InvalidDecision);
                }
                if self.bytes.is_empty() {
                    self.partial_since = Some(Instant::now());
                }
                self.bytes.extend_from_slice(&block[..n]);
                Ok(None)
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err(Failure::Unreachable),
        }
    }
}
fn check(v: &Value, kind: &str, run: &str, session: u64, extra: &[&str]) -> Result<(), Failure> {
    let keys = ["schema", "type", "runId", "sessionId"];
    let obj = v.as_object().ok_or(Failure::InvalidDecision)?;
    if v["schema"] != SCHEMA
        || v["type"] != kind
        || v["runId"] != run
        || !decimal_id(&v["sessionId"], session)
        || obj
            .keys()
            .any(|k| !keys.contains(&k.as_str()) && !extra.contains(&k.as_str()))
    {
        return Err(Failure::InvalidDecision);
    }
    Ok(())
}
fn code(v: &Value) -> Failure {
    match v
        .get("code")
        .or_else(|| v.get("reason"))
        .and_then(Value::as_str)
    {
        Some("authentication") => Failure::SignIn,
        Some("credentials") => Failure::Credentials,
        Some("usage_limit" | "dispatch_limit") => Failure::UsageLimit,
        Some("deadline") => Failure::Expired,
        Some("invalid_reply" | "protocol") => Failure::InvalidDecision,
        Some("unavailable") => Failure::Unreachable,
        _ => Failure::InvalidDecision,
    }
}

// Nonblocking connect: a full Unix listen backlog must not strand a worker.
fn connect(path: &std::path::Path, until: Instant, link: &Link) -> Result<UnixStream, Failure> {
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    };
    // SAFETY: initialized sockaddr, checked path bound, owned fd closes on every exit.
    unsafe {
        let raw = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        if raw < 0 {
            return Err(Failure::Unreachable);
        }
        let fd = OwnedFd::from_raw_fd(raw);
        if libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) < 0
            || libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) < 0
        {
            return Err(Failure::Unreachable);
        }
        let mut address: libc::sockaddr_un = std::mem::zeroed();
        address.sun_family = libc::AF_UNIX as _;
        let bytes = path.as_os_str().as_bytes();
        if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
            return Err(Failure::InvalidInput);
        }
        for (out, byte) in address.sun_path.iter_mut().zip(bytes) {
            *out = *byte as _;
        }
        #[cfg(target_os = "macos")]
        {
            address.sun_len = std::mem::size_of::<libc::sockaddr_un>() as _;
        }
        let result = libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as _,
        );
        if result < 0 {
            let error = std::io::Error::last_os_error().raw_os_error();
            if !matches!(error, Some(libc::EINPROGRESS) | Some(libc::EAGAIN)) {
                return Err(Failure::Unreachable);
            }
            loop {
                if link.terminal().is_some() {
                    return Err(Failure::Cancelled);
                }
                if Instant::now() >= until {
                    return Err(Failure::Expired);
                }
                let mut p = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let ready = libc::poll(&mut p, 1, 20);
                if ready < 0 {
                    return Err(Failure::Unreachable);
                }
                if ready == 0 {
                    continue;
                }
                let mut error: libc::c_int = 0;
                let mut len = std::mem::size_of_val(&error) as libc::socklen_t;
                if libc::getsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut error as *mut libc::c_int).cast(),
                    &mut len,
                ) < 0
                    || error != 0
                {
                    return Err(Failure::Unreachable);
                }
                break;
            }
        }
        let stream = UnixStream::from(fd);
        stream
            .set_nonblocking(false)
            .map_err(|_| Failure::Unreachable)?;
        Ok(stream)
    }
}

fn sample_clock(
    link: &Link,
    stream: &mut UnixStream,
    v: &Value,
    run: &str,
    session: u64,
) -> Result<(), Failure> {
    check(v, "clock_probe", run, session, &["probeId"])?;
    let probe = v["probeId"]
        .as_str()
        .filter(|p| identifier(p))
        .ok_or(Failure::InvalidDecision)?;
    let start = Instant::now();
    let sampler = link
        .sampler
        .try_lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or(Failure::WorkerUnavailable)?;
    let sample = sampler().ok_or(Failure::WorkerUnavailable)?;
    if sample.session_id != session
        || sample.elapsed_ms > 9_007_199_254_740_991
        || start.elapsed() > Duration::from_millis(100)
    {
        return Err(Failure::InvalidDecision);
    }
    let mut out = frame("clock_sample", run, session);
    out["probeId"] = json!(probe);
    out["nativeSessionElapsedMs"] = json!(sample.elapsed_ms);
    write_frame(stream, &out)?;

    Ok(())
}

fn transport(link: &Link, rx: Receiver<Event>, first: Event) -> Result<(), Failure> {
    let Event::Evaluate {
        identity,
        input,
        until,
        reply,
    } = first
    else {
        return Err(Failure::InvalidInput);
    };
    if link.terminal().is_some() {
        return Err(Failure::Cancelled);
    }
    let d = descriptor(&link.settings)?;
    let mut stream = connect(&d.socket_path, until, link)?;
    stream
        .set_read_timeout(Some(IO_SLICE))
        .map_err(|_| Failure::Unreachable)?;
    stream
        .set_write_timeout(Some(IO_SLICE))
        .map_err(|_| Failure::Unreachable)?;
    let mut hello = frame("hello", &d.run_id, identity.session);
    hello["nonce"] = json!(d.nonce);
    hello["expectedProvider"] = json!(link.settings.provider);
    hello["expectedModel"] = json!(link.settings.model);
    hello["expectedEffort"] = json!(link.settings.effort);
    write_frame(&mut stream, &hello)?;
    let mut reader = Reader::default();
    loop {
        if Instant::now() >= until || link.terminal().is_some() {
            return Err(Failure::Expired);
        }
        if let Some(v) = reader.read(&mut stream)? {
            check(
                &v,
                "ready",
                &d.run_id,
                identity.session,
                &[
                    "provider",
                    "model",
                    "effort",
                    "dispatchBudgetKind",
                    "dispatchLimit",
                    "dispatchesUsed",
                ],
            )?;
            if v["provider"] != link.settings.provider
                || v["model"] != link.settings.model
                || v["effort"] != link.settings.effort
                || v["dispatchBudgetKind"] != "cliDispatchAttempts"
                || v["dispatchLimit"]
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > 100)
                || v["dispatchesUsed"]
                    .as_u64()
                    .zip(v["dispatchLimit"].as_u64())
                    .is_none_or(|(used, limit)| used > limit)
            {
                return Err(Failure::InvalidDecision);
            }
            break;
        }
    }
    let session = identity.session;
    let send_eval = |s: &mut UnixStream, id: &Identity, input: Value, until: Instant| {
        let remaining = until.saturating_duration_since(Instant::now()).as_millis() as u64;
        if remaining == 0 {
            return Err(Failure::Expired);
        }
        let mut v = frame("evaluate", &d.run_id, id.session);
        id.add(&mut v);
        v["budgetMs"] = json!(remaining);
        v["input"] = input;
        write_frame(s, &v)
    };
    // Calibration is one-shot and must precede the first provider admission.
    loop {
        if Instant::now() >= until || link.terminal().is_some() {
            return Err(Failure::Expired);
        }
        if let Some(v) = reader.read(&mut stream)? {
            sample_clock(link, &mut stream, &v, &d.run_id, session)?;
            break;
        }
    }
    if link.terminal().is_some() {
        return Err(Failure::Cancelled);
    }
    send_eval(&mut stream, &identity, input, until)?;
    let mut active = Some((identity, reply, until));
    let mut awaiting: Option<(Identity, Instant)> = None;
    loop {
        // Drain one outbound event before checking terminal so a Rust failed
        // validation verdict is sent before its terminal cancellation.
        match rx.try_recv() {
            Ok(Event::Settled(id, verdict)) => {
                let Some((expected, at)) = awaiting.take() else {
                    return Err(Failure::InvalidDecision);
                };
                if id.session != session
                    || id.request != expected.request
                    || id.context != expected.context
                    || at.elapsed() > SETTLEMENT_GRACE
                {
                    return Err(Failure::InvalidDecision);
                }
                let mut v = frame("settled", &d.run_id, session);
                id.add(&mut v);
                v["verdict"] = json!(match verdict {
                    Settlement::Current => "current",
                    Settlement::StaleSuccess => "staleSuccess",
                    Settlement::Failed => "failed",
                });
                write_frame(&mut stream, &v)?;
                if verdict == Settlement::Failed {
                    return Err(Failure::InvalidDecision);
                }
            }
            Ok(Event::Evaluate {
                identity,
                input,
                until,
                reply,
            }) => {
                if link.terminal().is_some() {
                    return Err(Failure::Cancelled);
                }
                if active.is_some() || awaiting.is_some() || identity.session != session {
                    return Err(Failure::InvalidDecision);
                }
                send_eval(&mut stream, &identity, input, until)?;
                active = Some((identity, reply, until));
            }
            Ok(Event::Observation(observation)) => {
                let mut v = frame("cue_state", &d.run_id, session);
                v["observation"] = observation;
                write_frame(&mut stream, &v)?;
            }
            Err(TryRecvError::Disconnected) => return Err(Failure::Cancelled),
            Err(TryRecvError::Empty) => {}
        }
        if let Some(f) = link.terminal() {
            let mut v = frame("cancel", &d.run_id, session);
            if let Some((id, _, _)) = &active {
                id.add(&mut v);
            } else if let Some((id, _)) = &awaiting {
                id.add(&mut v);
            }
            v["reason"] = json!(link
                .reason
                .try_lock()
                .map(|r| r.wire())
                .unwrap_or("transport_failed"));
            let _ = write_frame(&mut stream, &v);
            return Err(f);
        }
        if active
            .as_ref()
            .is_some_and(|(_, _, at)| Instant::now() >= *at)
            || awaiting
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() > SETTLEMENT_GRACE)
        {
            return Err(Failure::Expired);
        }
        let Some(v) = reader.read(&mut stream)? else {
            continue;
        };
        match v["type"].as_str() {
            Some("result") => {
                check(
                    &v,
                    "result",
                    &d.run_id,
                    session,
                    &[
                        "requestId",
                        "contextRevision",
                        "value",
                        "elapsedMs",
                        "usage",
                    ],
                )?;
                let (id, reply, _) = active.take().ok_or(Failure::InvalidDecision)?;
                if !id.matches(&v)
                    || v["elapsedMs"]
                        .as_u64()
                        .is_none_or(|n| n > DEADLINE.as_millis() as u64)
                {
                    return Err(Failure::InvalidDecision);
                }
                if let Some(usage) = v.get("usage") {
                    let obj = usage.as_object().ok_or(Failure::InvalidDecision)?;
                    if obj.len() > 8
                        || obj
                            .iter()
                            .any(|(k, v)| k.len() > 32 || v.as_u64().is_none())
                    {
                        return Err(Failure::InvalidDecision);
                    }
                }
                let text =
                    serde_json::to_string(&v["value"]).map_err(|_| Failure::InvalidDecision)?;
                if text.len() > crate::cue_evaluator::MAX_REPLY_BYTES {
                    return Err(Failure::InvalidDecision);
                }
                awaiting = Some((id, Instant::now()));
                reply
                    .try_send(Ok(text))
                    .map_err(|_| Failure::WorkerUnavailable)?;
            }
            Some("failed") => {
                check(
                    &v,
                    "failed",
                    &d.run_id,
                    session,
                    &["requestId", "contextRevision", "code"],
                )?;
                if let Some((id, _, _)) = &active {
                    if !id.matches(&v) {
                        return Err(Failure::InvalidDecision);
                    }
                }
                return Err(code(&v));
            }
            Some("terminal") => {
                check(&v, "terminal", &d.run_id, session, &["code", "reason"])?;
                return Err(code(&v));
            }
            _ => return Err(Failure::InvalidDecision),
        }
    }
}

struct Globals {
    selected: bool,
    settings: Result<Settings, Failure>,
    active: Mutex<Option<Arc<Link>>>,
    sampler: Arc<Mutex<Option<ClockSampler>>>,
    fault: Arc<AtomicBool>,
}
static GLOBALS: OnceLock<Globals> = OnceLock::new();
pub(crate) fn initialize_from_environment() {
    GLOBALS.get_or_init(|| Globals {
        selected: std::env::var_os("TALKQTE_DEV_CUE_BACKEND").is_some(),
        settings: Settings::parse(|k| std::env::var(k).ok()),
        active: Mutex::new(None),
        sampler: Arc::new(Mutex::new(None)),
        fault: Arc::new(AtomicBool::new(false)),
    });
}
// An explicit invalid selector claims the lab path too, so it fails closed
// rather than silently falling through to the standalone Claude backend.
pub(crate) fn selected() -> bool {
    GLOBALS.get().is_some_and(|g| g.selected)
}
pub(crate) fn set_clock_sampler(sampler: ClockSampler) {
    if let Some(g) = GLOBALS.get() {
        if let Ok(mut slot) = g.sampler.try_lock() {
            *slot = Some(sampler);
        }
    }
}
pub(crate) fn connected_engine() -> Engine {
    let globals = GLOBALS.get();
    let settings = globals.and_then(|g| g.settings.clone().ok());
    let label = settings
        .as_ref()
        .map_or("Lab subscription", Settings::label);
    let service = if label == "Codex" {
        "OpenAI through the lab's Codex subscription CLI"
    } else {
        "Anthropic through the lab's Claude subscription CLI"
    };
    let policy=format!("Fictional development lab only. Sends recent and new conversation, the optional Your name setting and current/earlier cues to {service}. Never sends audio, prior notes, imported notes or focus lines. Near every transcript line may be sent, a few at a time. Uses an explicitly chosen subscription; no API fallback. The lab shares a CLI-dispatch cap across all roles; underlying provider request count is unobserved. Pause, Dismiss, Off and Stop terminate this strict lab run; Resume does not restart it. Provider retention follows that account's terms. No model cue text is persisted by this client.");
    let processor = ProcessorConfiguration::new(
        "lab-subscription".into(),
        1,
        settings
            .as_ref()
            .map_or("unavailable".into(), |s| s.model.clone()),
        ProcessingLocation::Hosted {
            service: service.into(),
        },
        "fictional-lab-v1".into(),
        ProcessorDisclosure::new(label.into(), policy).unwrap(),
    )
    .unwrap()
    .without_notes()
    .with_effort(
        settings
            .as_ref()
            .map_or("unavailable".into(), |s| s.effort.clone()),
    );
    if let (Some(g), Some(settings)) = (globals, settings) {
        let link = Link::new(settings, g.sampler.clone(), g.fault.clone());
        let Ok(mut active) = g.active.try_lock() else {
            return unavailable(processor);
        };
        g.fault.store(false, Ordering::Release);
        if let Some(previous) = active.take() {
            previous.cancel_reason(ControlReason::Replace);
        }
        *active = Some(link.clone());
        let worker = Worker::start(Adapter(link.clone()), DEADLINE).unwrap();
        return Engine::live_with_evaluator(worker, processor)
            .with_lab_lifecycle(link)
            .with_min_gap_ms(2_000);
    }
    unavailable(processor)
}
fn unavailable(processor: ProcessorConfiguration) -> Engine {
    struct Refuse;
    impl Evaluator for Refuse {
        fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
            Err(Failure::WorkerUnavailable)
        }
    }
    Engine::live_with_evaluator(Worker::start(Refuse, DEADLINE).unwrap(), processor)
        .lab_unavailable()
}
pub(crate) fn observe_published(engine: &Engine, snapshot: &CueSnapshot, emitted: bool) {
    if let Some(g) = GLOBALS.get() {
        if let Ok(active) = g.active.try_lock() {
            if let Some(link) = active.as_ref() {
                link.observe(engine, snapshot, emitted);
            }
        } else {
            g.fault.store(true, Ordering::Release);
        }
    }
}
pub(crate) fn cancel_active(reason: ControlReason) {
    if let Some(g) = GLOBALS.get() {
        if let Ok(active) = g.active.try_lock() {
            if let Some(link) = active.as_ref() {
                link.cancel_reason(reason);
            }
        } else {
            g.fault.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
#[path = "lab_evaluator_tests.rs"]
mod tests;
