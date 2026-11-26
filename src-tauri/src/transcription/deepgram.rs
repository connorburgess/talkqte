//! Deepgram Nova-3 live streaming, the first `StreamingTranscriber`.
//!
//! The request is fixed: `ListenRequest::lab` is its only constructor and
//! its URL always carries `mip_opt_out=true` (Deepgram's per-request opt-out
//! from model training and retention), checked again before connecting. The
//! credential is the person's own Deepgram API key from the Keychain, sent
//! once as a `Token` header on connect, or in a development launch a
//! short-lived token from an owner-only file, sent as a `Bearer` header. An
//! open stream outlives either.
//!
//! A socket thread sends 100 ms linear16 frames, a KeepAlive while no audio
//! is sent, a Finalize when speech has gone 6 s without a final, and
//! CloseStream on finish or at the minute cap.

use super::cloud::{Budget, Full, Language, StreamingTranscriber, SttEvent, SttFailure};
use super::SAMPLE_RATE;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// English: Nova-3 with `language=en`, `smart_format=true`, and 600 ms endpointing
/// so natural conversational pauses do not chop sentences into tiny fragments.
pub const QUERY_EN: &str = "model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&smart_format=true&diarize=true&endpointing=600&utterance_end_ms=1000&vad_events=true&mip_opt_out=true";
/// Multilingual: Nova-3 with `language=multi`, which transcribes several
/// languages and follows switches between them within one stream. Deepgram
/// recommends 100 ms endpointing for code-switching; everything else is the
/// English request. Deepgram cannot detect a language on a live stream, so
/// the choice is made before a session starts.
pub const QUERY_MULTI: &str = "model=nova-3&language=multi&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&smart_format=true&diarize=true&endpointing=100&utterance_end_ms=1000&vad_events=true&mip_opt_out=true";
#[cfg(test)]
const QUERY: &str = QUERY_EN;
const HOST: &str = "api.deepgram.com";
/// Samples per frame sent: 100 ms.
const FRAME: usize = SAMPLE_RATE / 10;
/// Sent while no audio is, so the stream stays open through silence.
const KEEP_ALIVE: Duration = Duration::from_secs(5);
/// Speech that has gone this long without a final is finalized by request,
/// so a speaker who runs on does not hold a line back indefinitely.
pub const FINALIZE_AFTER: Duration = Duration::from_secs(6);
/// Blocks waiting to be sent before new audio is dropped (about 10 s).
const QUEUE: usize = 128;

/// One of the two requests this app makes. Neither can be built without the
/// opt-out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListenRequest {
    language: Language,
}

impl ListenRequest {
    /// The English request.
    pub fn lab() -> Self {
        Self::for_language(Language::English)
    }

    pub fn for_language(language: Language) -> Self {
        Self { language }
    }

    /// The exact query string sent, for the run's evidence.
    pub fn query(&self) -> &'static str {
        match self.language {
            Language::English => QUERY_EN,
            Language::Multilingual => QUERY_MULTI,
        }
    }

    pub fn url(&self) -> String {
        format!("wss://{HOST}/v1/listen?{}", self.query())
    }
}

/// Refuses a URL that does not carry the opt-out exactly once.
fn checked(url: &str) -> Result<&str, SttFailure> {
    let query = url.split_once('?').map_or("", |(_, q)| q);
    let opt_outs = query
        .split('&')
        .filter(|p| *p == "mip_opt_out=true")
        .count();
    let others = query
        .split('&')
        .filter(|p| p.starts_with("mip_opt_out"))
        .count();
    if opt_outs == 1 && others == 1 {
        Ok(url)
    } else {
        Err(SttFailure::Protocol)
    }
}

/// One open stream's transport. Tests supply a fake; nothing in tests
/// reaches the network.
pub trait Socket: Send {
    fn send_binary(&mut self, data: Vec<u8>) -> Result<(), SttFailure>;
    fn send_text(&mut self, text: &str) -> Result<(), SttFailure>;
    /// A text message if one arrives within a short wait, else None.
    fn recv(&mut self) -> Result<Option<String>, SttFailure>;
    fn close(&mut self);
}

pub trait Connector: Send + 'static {
    fn connect(&self, url: &str, token: &str) -> Result<Box<dyn Socket>, SttFailure>;
}

/// An HTTP refusal at the handshake, as a fixed code.
pub fn handshake_failure(status: u16) -> SttFailure {
    match status {
        401 | 403 => SttFailure::Auth,
        402 => SttFailure::Quota,
        429 => SttFailure::RateLimited,
        500..=599 => SttFailure::Unavailable,
        _ => SttFailure::Network,
    }
}

pub struct DeepgramStream {
    audio: Option<SyncSender<Vec<f32>>>,
    events: Receiver<SttEvent>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl DeepgramStream {
    /// Starts the socket thread. The token is moved to that thread and
    /// dropped as soon as the connection is open.
    /// `budget` is the audio this launch may still send, shared by every
    /// stream of the launch.
    pub fn start(
        connector: impl Connector,
        request: ListenRequest,
        token: impl Into<Token>,
        budget: impl Into<Budget>,
    ) -> Self {
        Self::start_with(connector, request, token, budget, Timing::default())
    }

    fn start_with(
        connector: impl Connector,
        request: ListenRequest,
        token: impl Into<Token>,
        budget: impl Into<Budget>,
        timing: Timing,
    ) -> Self {
        let budget = budget.into();
        let token = token.into();
        let (audio, queue) = mpsc::sync_channel(QUEUE);
        let (tx, events) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("talkqte-cloud-transcription".into())
            .spawn(move || run(connector, request, token, budget, timing, queue, tx, flag))
            .ok();
        Self {
            audio: Some(audio),
            events,
            stop,
            thread,
        }
    }
}

impl StreamingTranscriber for DeepgramStream {
    fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
        let audio = self.audio.as_ref().ok_or(Full)?;
        audio.try_send(samples.to_vec()).map_err(|_| Full)
    }

    fn poll(&mut self) -> Vec<SttEvent> {
        self.events.try_iter().collect()
    }

    fn finish(&mut self, wait: Duration) -> Vec<SttEvent> {
        // Closing the queue asks the thread to send the rest and close.
        self.audio.take();
        let until = Instant::now() + wait;
        let mut events = Vec::new();
        while Instant::now() < until {
            match self.events.recv_timeout(Duration::from_millis(20)) {
                Ok(event) => events.push(event),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.thread.as_ref().is_some_and(|t| t.is_finished()) {
                        events.extend(self.events.try_iter());
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        self.abort();
        events
    }

    fn abort(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.audio.take();
    }
}

impl Drop for DeepgramStream {
    fn drop(&mut self) {
        self.abort();
    }
}

/// When the socket thread speaks without audio to send.
#[derive(Clone, Copy)]
struct Timing {
    keep_alive: Duration,
    finalize_after: Duration,
    token_wait: Duration,
    /// Audio sent but nothing heard back for this long: ask for a reply
    /// (`Finalize`, which Deepgram answers even when there is no speech).
    quiet_probe: Duration,
    /// Audio sent but nothing heard back for this long: the stream is
    /// stalled and ends with `stalled`.
    stall_after: Duration,
    /// One frame write that takes longer than this means the connection is
    /// not keeping up; the stream ends with `stalled`.
    slow_write: Duration,
    /// Frames sent between two reads, so replies and a close are read even
    /// while audio is backed up.
    frames_per_read: usize,
    #[cfg(test)]
    now: fn() -> Instant,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            keep_alive: KEEP_ALIVE,
            finalize_after: FINALIZE_AFTER,
            token_wait: TOKEN_WAIT,
            quiet_probe: QUIET_PROBE,
            stall_after: STALL_AFTER,
            slow_write: SLOW_WRITE,
            frames_per_read: FRAMES_PER_READ,
            #[cfg(test)]
            now: Instant::now,
        }
    }
}

impl Timing {
    fn now(&self) -> Instant {
        #[cfg(test)]
        {
            (self.now)()
        }
        #[cfg(not(test))]
        {
            Instant::now()
        }
    }

    fn elapsed(&self, since: Instant) -> Duration {
        self.now().duration_since(since)
    }
}

/// See `Timing`.
const QUIET_PROBE: Duration = Duration::from_secs(5);
const STALL_AFTER: Duration = Duration::from_secs(10);
const SLOW_WRITE: Duration = Duration::from_secs(3);
/// One second of 100 ms frames.
const FRAMES_PER_READ: usize = 10;
/// At most this much audio (two seconds) waits on the socket thread beyond
/// the bounded queue.
const MAX_PENDING_SAMPLES: usize = FRAME * 20;

#[allow(clippy::too_many_arguments)]
fn run(
    connector: impl Connector,
    request: ListenRequest,
    mut token: Token,
    budget: Budget,
    timing: Timing,
    queue: Receiver<Vec<f32>>,
    events: mpsc::Sender<SttEvent>,
    stop: Arc<AtomicBool>,
) {
    // The token may arrive after approval: the lab hands it over only once
    // it has seen the review. Audio waits in the bounded queue meanwhile.
    let until = timing.now() + timing.token_wait;
    let token = loop {
        if stop.load(Ordering::Acquire) {
            return;
        }
        match token.take() {
            Ok(Some(token)) => break token,
            Ok(None) => {}
            Err(failure) => {
                let _ = events.send(SttEvent::Failed(failure));
                return;
            }
        }
        if timing.now() >= until {
            let _ = events.send(SttEvent::Failed(SttFailure::Settings));
            return;
        }
        std::thread::sleep(TOKEN_POLL);
    };
    let url = request.url();
    let socket = checked(&url).and_then(|url| connector.connect(url, &token));
    drop(token);
    let mut socket = match socket {
        Ok(socket) => socket,
        Err(failure) => {
            let _ = events.send(SttEvent::Failed(failure));
            return;
        }
    };
    let query = url.split_once('?').map_or("", |(_, query)| query);
    let _ = events.send(SttEvent::Connected {
        query: query.to_string(),
    });
    let mut pending: Vec<i16> = Vec::with_capacity(FRAME * 2);
    let mut last_send = timing.now();
    // When anything was last heard from Deepgram, and whether audio has gone
    // out since; a probe is sent once per quiet spell.
    let mut last_heard = timing.now();
    let mut sent_since_heard = false;
    let mut probed = false;
    let mut unfinalized: Option<Instant> = None;
    let mut seq = 0u64;
    let mut closing: Option<Instant> = None;
    let mut cap_reached = false;
    loop {
        if stop.load(Ordering::Acquire) {
            socket.close();
            return;
        }
        if closing.is_none() {
            // Take from the bounded queue only while little is waiting here:
            // if the socket falls behind, audio backs up in the queue, where
            // it is dropped and counted, instead of piling up unbounded.
            while pending.len() < MAX_PENDING_SAMPLES {
                match queue.try_recv() {
                    Ok(block) => pending.extend(
                        block
                            .iter()
                            .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16),
                    ),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        closing = Some(timing.now());
                        break;
                    }
                }
            }
            let flush = closing.is_some();
            let mut sent_frames = 0;
            while (pending.len() >= FRAME || (flush && !pending.is_empty()))
                && sent_frames < timing.frames_per_read
            {
                // Checked per frame, so a withdrawn review stops what is
                // queued from going out.
                if stop.load(Ordering::Acquire) {
                    socket.close();
                    return;
                }
                let take = budget.reserve(pending.len().min(FRAME) as u64) as usize;
                if take == 0 {
                    cap_reached = true;
                    break;
                }
                let bytes: Vec<u8> = pending.drain(..take).flat_map(i16::to_le_bytes).collect();
                let started = timing.now();
                if let Err(failure) = socket.send_binary(bytes) {
                    let _ = events.send(SttEvent::Failed(failure));
                    return;
                }
                if timing.elapsed(started) > timing.slow_write {
                    let _ = events.send(SttEvent::Failed(SttFailure::Stalled));
                    socket.close();
                    return;
                }
                last_send = timing.now();
                sent_since_heard = true;
                sent_frames += 1;
            }
            // Audio is going out but nothing has come back: ask once, then
            // give up, rather than let audio pile up unheard.
            if sent_since_heard && timing.elapsed(last_heard) >= timing.stall_after {
                let _ = events.send(SttEvent::Failed(SttFailure::Stalled));
                socket.close();
                return;
            }
            if sent_since_heard && !probed && timing.elapsed(last_heard) >= timing.quiet_probe {
                probed = true;
                if socket.send_text(r#"{"type":"Finalize"}"#).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
            }
            if cap_reached || closing.is_some() {
                closing.get_or_insert_with(|| timing.now());
                if socket.send_text(r#"{"type":"CloseStream"}"#).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
            } else if timing.elapsed(last_send) >= timing.keep_alive {
                if socket.send_text(r#"{"type":"KeepAlive"}"#).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
                last_send = timing.now();
            }
            if unfinalized.is_some_and(|since| timing.elapsed(since) >= timing.finalize_after) {
                if socket.send_text(r#"{"type":"Finalize"}"#).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
                unfinalized = None;
            }
        } else if closing.is_some_and(|at| timing.elapsed(at) > Duration::from_secs(5)) {
            socket.close();
            if cap_reached {
                let _ = events.send(SttEvent::Failed(SttFailure::CapReached));
            }
            return;
        }
        let reply = socket.recv();
        if matches!(reply, Ok(Some(_))) {
            last_heard = timing.now();
            sent_since_heard = false;
            probed = false;
        }
        match reply {
            Ok(Some(text)) => match parse(&text, &mut seq) {
                Ok(Some(event)) => {
                    match &event {
                        SttEvent::Final { .. } => unfinalized = None,
                        SttEvent::Partial => {
                            unfinalized.get_or_insert_with(|| timing.now());
                        }
                        SttEvent::Failed(_) | SttEvent::Connected { .. } => {}
                    }
                    if events.send(event).is_err() {
                        socket.close();
                        return;
                    }
                }
                Ok(None) => {}
                Err(failure) => {
                    let _ = events.send(SttEvent::Failed(failure));
                    socket.close();
                    return;
                }
            },
            Ok(None) => {}
            Err(SttFailure::Closed) if closing.is_some() => {
                if cap_reached {
                    let _ = events.send(SttEvent::Failed(SttFailure::CapReached));
                }
                return;
            }
            Err(failure) => {
                let _ = events.send(SttEvent::Failed(failure));
                return;
            }
        }
    }
}

/// One provider message as an event. Only `Results` with words carry text;
/// metadata, speech-started and utterance-end messages are ignored.
pub(crate) fn parse(text: &str, seq: &mut u64) -> Result<Option<SttEvent>, SttFailure> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| SttFailure::Protocol)?;
    match value.get("type").and_then(|t| t.as_str()) {
        Some("Results") => {}
        Some("Metadata" | "SpeechStarted" | "UtteranceEnd") => return Ok(None),
        Some("Error") | None => return Err(SttFailure::Protocol),
        Some(_) => return Ok(None),
    }
    let alternative = &value["channel"]["alternatives"][0];
    let transcript = alternative["transcript"]
        .as_str()
        .ok_or(SttFailure::Protocol)?
        .trim();
    if transcript.is_empty() {
        return Ok(None);
    }
    if value["is_final"].as_bool() != Some(true) {
        return Ok(Some(SttEvent::Partial));
    }
    let start = value["start"].as_f64().ok_or(SttFailure::Protocol)?;
    let duration = value["duration"].as_f64().ok_or(SttFailure::Protocol)?;
    if !(start.is_finite() && duration.is_finite() && start >= 0.0 && duration >= 0.0) {
        return Err(SttFailure::Protocol);
    }
    // The most common label among the words, kept only as untrusted.
    let mut counts = std::collections::BTreeMap::new();
    for word in alternative["words"].as_array().into_iter().flatten() {
        if let Some(speaker) = word["speaker"].as_u64().and_then(|s| u32::try_from(s).ok()) {
            *counts.entry(speaker).or_insert(0u32) += 1;
        }
    }
    let untrusted_speaker = counts
        .into_iter()
        .max_by_key(|&(speaker, count)| (count, std::cmp::Reverse(speaker)))
        .map(|(speaker, _)| speaker);
    // A result's start and duration cover its audio window, which can begin
    // well before the first word (the first result starts at the stream's
    // first sample, the moment of approval). Time the line by its words
    // when they say, within that window.
    let window_end = start + duration;
    let time = |word: &serde_json::Value, key: &str| {
        word[key]
            .as_f64()
            .filter(|t| t.is_finite() && (start..=window_end).contains(t))
    };
    let words = alternative["words"].as_array();
    let first = words.and_then(|w| w.first()).and_then(|w| time(w, "start"));
    let last = words.and_then(|w| w.last()).and_then(|w| time(w, "end"));
    let (from, to) = match (first, last) {
        (Some(from), Some(to)) if from <= to => (from, to),
        _ => (start, window_end),
    };
    *seq += 1;
    Ok(Some(SttEvent::Final {
        seq: *seq,
        text: transcript.chars().take(1_000).collect(),
        start_ms: (from * 1_000.0) as u64,
        end_ms: (to * 1_000.0) as u64,
        untrusted_speaker,
    }))
}

/// Opens the live stream with the token from the settings' owner-only file.
/// The token is read on the socket thread, from the owner-only file, as
/// soon as a valid one is there: an empty placeholder is waited for, up to
/// `TOKEN_WAIT` after approval.
pub fn opener(settings: super::cloud::Settings) -> super::cloud::Opener {
    Box::new(move || {
        let budget = super::cloud::launch_budget(&settings);
        let path = settings.token_file;
        Ok(Box::new(DeepgramStream::start(
            Network(Auth::Bearer),
            ListenRequest::for_language(settings.language),
            Token::from_file(path),
            budget,
        )) as Box<dyn StreamingTranscriber>)
    })
}

/// Opens replacement streams after a connection failure. Each reads the
/// token file again, so the token must stay there until Stop.
pub fn reopener(settings: super::cloud::Settings) -> super::cloud::Reopener {
    Box::new(move || {
        Ok(Box::new(DeepgramStream::start(
            Network(Auth::Bearer),
            ListenRequest::for_language(settings.language),
            Token::from_file(settings.token_file.clone()),
            super::cloud::launch_budget(&settings),
        )) as Box<dyn StreamingTranscriber>)
    })
}

/// The stream and its replacements for one session with the person's own
/// key: both draw on the one `budget` made for that session, so reconnects
/// share its cap. The key is read from the Keychain on the socket thread
/// once the review is approved, and again by each replacement, so a key
/// replaced in Settings is used.
pub fn key_streams(
    budget: Budget,
    language: Language,
) -> (super::cloud::Opener, super::cloud::Reopener) {
    key_streams_with(Network(Auth::Key), Token::from_keychain, budget, language)
}

fn key_streams_with<C: Connector + Clone>(
    connector: C,
    token: fn() -> Token,
    budget: Budget,
    language: Language,
) -> (super::cloud::Opener, super::cloud::Reopener) {
    let first = (connector.clone(), budget.clone());
    let opener: super::cloud::Opener = Box::new(move || {
        Ok(Box::new(DeepgramStream::start(
            first.0,
            ListenRequest::for_language(language),
            token(),
            first.1,
        )) as Box<dyn StreamingTranscriber>)
    });
    let reopener: super::cloud::Reopener = Box::new(move || {
        Ok(Box::new(DeepgramStream::start(
            connector.clone(),
            ListenRequest::for_language(language),
            token(),
            budget.clone(),
        )) as Box<dyn StreamingTranscriber>)
    });
    (opener, reopener)
}

/// How long a stream waits after approval for a valid token.
const TOKEN_WAIT: Duration = Duration::from_secs(10);
/// How often it looks.
const TOKEN_POLL: Duration = Duration::from_millis(50);

/// Where the socket thread gets its credential: a fixed one, the owner-only
/// file read when a valid token is there, or the stored key. The text is
/// wiped once the handshake is sent.
pub struct Token(Box<dyn FnMut() -> Result<Option<Zeroizing<String>>, SttFailure> + Send>);

impl Token {
    pub fn from_file(path: std::path::PathBuf) -> Self {
        Self(Box::new(move || {
            Ok(super::cloud::read_token(&path).ok().map(Zeroizing::new))
        }))
    }

    /// The person's own Deepgram key, from the Keychain.
    pub fn from_keychain() -> Self {
        Self::from_keys(crate::provider_keys::global())
    }

    /// Read once per stream attempt: a missing key, or a Keychain that
    /// refuses or asks, is not asked again. The stream stops at once with
    /// `key_unavailable`, so the person is told to check the key rather than
    /// waiting out the token wait for a settings problem.
    fn from_keys(keys: &'static crate::provider_keys::Keys) -> Self {
        Self(Box::new(move || {
            keys.get(crate::provider_keys::Provider::Deepgram)
                .map(|key| Some(Zeroizing::new(key.expose().to_string())))
                .map_err(|_| SttFailure::KeyUnavailable)
        }))
    }

    fn take(&mut self) -> Result<Option<Zeroizing<String>>, SttFailure> {
        (self.0)()
    }
}

impl From<String> for Token {
    fn from(token: String) -> Self {
        let mut token = Some(Zeroizing::new(token));
        Self(Box::new(move || Ok(token.take())))
    }
}

/// How long opening the TCP connection may take before the stream fails.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How the credential is presented to Deepgram.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Auth {
    /// A short-lived token from `/v1/auth/grant` (development launches).
    Bearer,
    /// The person's own API key.
    Key,
}

impl Auth {
    /// The `Authorization` header value. Never logged.
    pub fn header(self, credential: &str) -> Zeroizing<String> {
        Zeroizing::new(match self {
            Self::Bearer => format!("Bearer {credential}"),
            Self::Key => format!("Token {credential}"),
        })
    }
}

/// The network connector: TLS with the bundled web roots, a WebSocket
/// handshake carrying the credential in the `Authorization` header, then
/// short read waits. A key Deepgram refuses is marked rejected, so Settings
/// says so and the next live start is refused until it is replaced.
#[derive(Clone)]
pub struct Network(pub Auth);

impl Connector for Network {
    fn connect(&self, url: &str, token: &str) -> Result<Box<dyn Socket>, SttFailure> {
        let result = self.connect_inner(url, token);
        note_refusal(crate::provider_keys::global(), self.0, &result);
        result
    }
}

/// A refused key (401 or 403) is marked rejected; a refused development
/// token is not the person's key and leaves it alone.
fn note_refusal<T>(keys: &crate::provider_keys::Keys, auth: Auth, result: &Result<T, SttFailure>) {
    if auth == Auth::Key && matches!(result, Err(SttFailure::Auth)) {
        keys.mark_rejected(crate::provider_keys::Provider::Deepgram);
    }
}

impl Network {
    fn connect_inner(&self, url: &str, token: &str) -> Result<Box<dyn Socket>, SttFailure> {
        use tungstenite::client::IntoClientRequest;
        let mut request = url
            .into_client_request()
            .map_err(|_| SttFailure::Protocol)?;
        let mut value = tungstenite::http::HeaderValue::from_str(&self.0.header(token))
            .map_err(|_| SttFailure::Settings)?;
        value.set_sensitive(true);
        request.headers_mut().insert("Authorization", value);
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| SttFailure::Network)?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name =
            rustls::pki_types::ServerName::try_from(HOST).map_err(|_| SttFailure::Network)?;
        let tls = rustls::ClientConnection::new(Arc::new(config), name)
            .map_err(|_| SttFailure::Network)?;
        let tcp = {
            use std::net::ToSocketAddrs;
            let addresses = (HOST, 443)
                .to_socket_addrs()
                .map_err(|_| SttFailure::Network)?;
            addresses
                .into_iter()
                .find_map(|address| {
                    std::net::TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).ok()
                })
                .ok_or(SttFailure::Network)?
        };
        tcp.set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| SttFailure::Network)?;
        tcp.set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|_| SttFailure::Network)?;
        let stream = rustls::StreamOwned::new(tls, tcp);
        let (socket, _) = tungstenite::client(request, stream).map_err(|error| match error {
            tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)) => {
                handshake_failure(response.status().as_u16())
            }
            _ => SttFailure::Network,
        })?;
        socket
            .get_ref()
            .sock
            .set_read_timeout(Some(Duration::from_millis(20)))
            .map_err(|_| SttFailure::Network)?;
        Ok(Box::new(NetworkSocket(socket)))
    }
}

type TlsSocket =
    tungstenite::WebSocket<rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>>;

struct NetworkSocket(TlsSocket);

fn io_failure(error: tungstenite::Error) -> Result<Option<String>, SttFailure> {
    match error {
        tungstenite::Error::Io(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Ok(None)
        }
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            Err(SttFailure::Closed)
        }
        _ => Err(SttFailure::Network),
    }
}

impl Socket for NetworkSocket {
    fn send_binary(&mut self, data: Vec<u8>) -> Result<(), SttFailure> {
        self.0
            .send(tungstenite::Message::Binary(data.into()))
            .map_err(|_| SttFailure::Network)
    }

    fn send_text(&mut self, text: &str) -> Result<(), SttFailure> {
        self.0
            .send(tungstenite::Message::Text(text.into()))
            .map_err(|_| SttFailure::Network)
    }

    fn recv(&mut self) -> Result<Option<String>, SttFailure> {
        match self.0.read() {
            Ok(tungstenite::Message::Text(text)) => Ok(Some(text.to_string())),
            Ok(tungstenite::Message::Close(_)) => Err(SttFailure::Closed),
            Ok(_) => Ok(None),
            Err(error) => io_failure(error),
        }
    }

    fn close(&mut self) {
        let _ = self.0.close(None);
        let _ = self.0.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// What the fake socket saw, and what it will answer.
    #[derive(Default)]
    struct Wire {
        url: Option<String>,
        token: Option<String>,
        binary: Vec<usize>,
        text: Vec<String>,
        replies: std::collections::VecDeque<Result<Option<String>, SttFailure>>,
        closed: bool,
        /// Each binary send takes this long, as on a slow network.
        send_delay: Duration,
        /// How many binary frames had been sent when the first reply was read.
        binary_at_first_reply: Option<usize>,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<Wire>>, Option<SttFailure>);

    impl Connector for Fake {
        fn connect(&self, url: &str, token: &str) -> Result<Box<dyn Socket>, SttFailure> {
            if let Some(failure) = self.1 {
                return Err(failure);
            }
            let mut wire = self.0.lock().unwrap();
            wire.url = Some(url.into());
            wire.token = Some(token.into());
            Ok(Box::new(self.clone()))
        }
    }

    impl Socket for Fake {
        fn send_binary(&mut self, data: Vec<u8>) -> Result<(), SttFailure> {
            let delay = self.0.lock().unwrap().send_delay;
            std::thread::sleep(delay);
            self.0.lock().unwrap().binary.push(data.len());
            Ok(())
        }
        fn send_text(&mut self, text: &str) -> Result<(), SttFailure> {
            let mut wire = self.0.lock().unwrap();
            wire.text.push(text.into());
            if text.contains("CloseStream") {
                wire.replies.push_back(Err(SttFailure::Closed));
            }
            Ok(())
        }
        fn recv(&mut self) -> Result<Option<String>, SttFailure> {
            std::thread::sleep(Duration::from_millis(2));
            let mut wire = self.0.lock().unwrap();
            let reply = wire.replies.pop_front().unwrap_or(Ok(None));
            if matches!(reply, Ok(Some(_))) && wire.binary_at_first_reply.is_none() {
                wire.binary_at_first_reply = Some(wire.binary.len());
            }
            reply
        }
        fn close(&mut self) {
            self.0.lock().unwrap().closed = true;
        }
    }

    fn result(transcript: &str, is_final: bool, start: f64, speakers: &[u64]) -> String {
        let words: Vec<_> = speakers
            .iter()
            .map(|s| serde_json::json!({"word":"fictional","start":start,"end":start+0.1,"speaker":s}))
            .collect();
        serde_json::json!({"type":"Results","is_final":is_final,"speech_final":is_final,"start":start,"duration":1.5,
            "channel":{"alternatives":[{"transcript":transcript,"words":words}]}})
        .to_string()
    }

    #[test]
    fn a_line_is_timed_by_its_words_not_by_its_audio_window() {
        // The first result's window starts at the stream's first sample, the
        // moment of approval; its words start two seconds later.
        let text = serde_json::json!({"type":"Results","is_final":true,"start":0.0,"duration":3.5,
            "channel":{"alternatives":[{"transcript":"Before I go tomorrow,","words":[
                {"word":"before","start":2.04,"end":2.3,"speaker":0},
                {"word":"tomorrow","start":2.9,"end":3.32,"speaker":0}]}]}})
        .to_string();
        let mut seq = 0;
        let Some(SttEvent::Final {
            start_ms, end_ms, ..
        }) = parse(&text, &mut seq).unwrap()
        else {
            panic!("a final")
        };
        assert_eq!((start_ms, end_ms), (2_040, 3_320));
        // Word times outside the window are not trusted: the window is used.
        let odd = serde_json::json!({"type":"Results","is_final":true,"start":1.0,"duration":1.0,
            "channel":{"alternatives":[{"transcript":"Fictional.","words":[
                {"word":"fictional","start":9.0,"end":9.5}]}]}})
        .to_string();
        let Some(SttEvent::Final {
            start_ms, end_ms, ..
        }) = parse(&odd, &mut seq).unwrap()
        else {
            panic!("a final")
        };
        assert_eq!((start_ms, end_ms), (1_000, 2_000));
    }

    fn wait_for(
        stream: &mut DeepgramStream,
        mut done: impl FnMut(&[SttEvent]) -> bool,
    ) -> Vec<SttEvent> {
        let until = Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        while !done(&events) {
            assert!(
                Instant::now() < until,
                "socket thread did not deliver: {events:?}"
            );
            events.extend(stream.poll());
            std::thread::sleep(Duration::from_millis(5));
        }
        events
    }

    #[test]
    fn each_language_sends_its_exact_query_and_reports_it_when_connected() {
        for (language, query) in [
            (Language::English, QUERY_EN),
            (Language::Multilingual, QUERY_MULTI),
        ] {
            let fake = Fake::default();
            let mut stream = DeepgramStream::start(
                fake.clone(),
                ListenRequest::for_language(language),
                "t".repeat(24),
                Duration::from_secs(60),
            );
            stream.push(&[0.25; FRAME]).unwrap();
            let events = stream.finish(Duration::from_secs(2));
            let url = fake.0.lock().unwrap().url.clone().unwrap();
            assert_eq!(url, format!("wss://api.deepgram.com/v1/listen?{query}"));
            assert_eq!(checked(&url), Ok(url.as_str()));
            assert!(events.contains(&SttEvent::Connected {
                query: query.to_string()
            }));
        }
        // The two differ only where Deepgram's documentation says they should.
        assert_eq!(
            QUERY_MULTI,
            QUERY_EN
                .replace("language=en", "language=multi")
                .replace("endpointing=600", "endpointing=100")
        );
    }

    #[test]
    fn a_multilingual_sessions_replacement_streams_stay_multilingual() {
        let fake = Fake::default();
        let (opener, mut reopener) = key_streams_with(
            fake.clone(),
            || Token::from("t".repeat(24)),
            Budget::new(Duration::from_secs(60)),
            Language::Multilingual,
        );
        let mut first = opener().unwrap();
        first.push(&[0.25; FRAME]).unwrap();
        let _ = first.finish(Duration::from_secs(2));
        let opened = fake.0.lock().unwrap().url.take().unwrap();
        assert!(opened.ends_with(QUERY_MULTI));
        // The replacement after a connection failure keeps the language.
        let mut replacement = reopener().unwrap();
        replacement.push(&[0.25; FRAME]).unwrap();
        let _ = replacement.finish(Duration::from_secs(2));
        let reopened = fake.0.lock().unwrap().url.take().unwrap();
        assert_eq!(reopened, opened);
    }

    #[test]
    fn the_request_always_opts_out_and_the_token_is_only_a_header() {
        let request = ListenRequest::lab();
        let url = request.url();
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?"));
        assert_eq!(checked(&url), Ok(url.as_str()));
        for part in [
            "model=nova-3",
            "encoding=linear16",
            "sample_rate=16000",
            "channels=1",
            "punctuate=true",
            "smart_format=true",
            "diarize=true",
            "endpointing=600",
            "mip_opt_out=true",
        ] {
            assert!(request.query().split('&').any(|p| p == part), "{part}");
        }
        assert_eq!(
            checked("wss://h/v1/listen?model=nova-3"),
            Err(SttFailure::Protocol)
        );
        assert_eq!(
            checked("wss://h/v1/listen?mip_opt_out=false"),
            Err(SttFailure::Protocol)
        );
        assert_eq!(
            checked("wss://h/v1/listen?mip_opt_out=true&mip_opt_out=false"),
            Err(SttFailure::Protocol)
        );
        let fake = Fake::default();
        let token = "fictional.token_".to_string() + &"y".repeat(30);
        let mut stream = DeepgramStream::start(
            fake.clone(),
            request,
            token.clone(),
            Duration::from_secs(60),
        );
        stream.push(&[0.25; FRAME]).unwrap();
        let _ = stream.finish(Duration::from_secs(2));
        let wire = fake.0.lock().unwrap();
        assert_eq!(wire.url.as_deref(), Some(url.as_str()));
        assert!(!wire.url.as_deref().unwrap().contains(&token));
        assert_eq!(wire.token.as_deref(), Some(token.as_str()));
    }

    /// A store that counts reads, so a test can see the Keychain is asked
    /// once per stream attempt.
    #[derive(Default)]
    struct Counting(
        crate::provider_keys::MemoryStore,
        std::sync::atomic::AtomicUsize,
    );
    impl crate::provider_keys::SecretStore for &'static Counting {
        fn get(
            &self,
            account: &str,
        ) -> Result<Option<crate::provider_keys::Secret>, crate::provider_keys::StoreError>
        {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0.get(account)
        }
        fn set(
            &self,
            account: &str,
            secret: &crate::provider_keys::Secret,
        ) -> Result<(), crate::provider_keys::StoreError> {
            self.0.set(account, secret)
        }
        fn delete(&self, account: &str) -> Result<(), crate::provider_keys::StoreError> {
            self.0.delete(account)
        }
    }

    struct Offline;
    impl crate::provider_keys::Probe for Offline {
        fn check(
            &self,
            _: crate::provider_keys::Provider,
            _: &crate::provider_keys::Secret,
        ) -> crate::provider_keys::ProbeResult {
            crate::provider_keys::ProbeResult::Unreachable
        }
    }

    fn fictional_keys() -> &'static crate::provider_keys::Keys {
        Box::leak(Box::new(crate::provider_keys::Keys::new(
            Box::new(crate::provider_keys::MemoryStore::default()),
            Box::new(Offline),
        )))
    }

    #[test]
    fn the_persons_key_is_sent_only_as_a_token_header_on_the_opt_out_url() {
        use crate::provider_keys::{KeyState, Provider};
        const KEY: &str = "0123456789abcdef0123456789abcdef01234567";
        let keys = fictional_keys();
        keys.set(Provider::Deepgram, KEY).unwrap();
        let fake = Fake::default();
        let mut stream = DeepgramStream::start(
            fake.clone(),
            ListenRequest::lab(),
            Token::from_keys(keys),
            Duration::from_secs(60),
        );
        stream.push(&[0.25; FRAME]).unwrap();
        let _ = stream.finish(Duration::from_secs(2));
        let wire = fake.0.lock().unwrap();
        // The stored key, on the opt-out URL, never in it.
        assert_eq!(wire.token.as_deref(), Some(KEY));
        let url = wire.url.as_deref().unwrap();
        assert!(url.ends_with("mip_opt_out=true") && !url.contains(KEY));
        // The header Deepgram expects for an API key, unlike the lab's token.
        assert_eq!(*Auth::Key.header(KEY), format!("Token {KEY}"));
        assert_eq!(*Auth::Bearer.header("t"), "Bearer t");
        // A refusal of the key marks it rejected; a lab token's does not.
        note_refusal::<()>(keys, Auth::Bearer, &Err(SttFailure::Auth));
        assert_eq!(keys.status().deepgram.state, KeyState::Set);
        note_refusal::<()>(keys, Auth::Key, &Err(SttFailure::Network));
        assert_eq!(keys.status().deepgram.state, KeyState::Set);
        note_refusal::<()>(keys, Auth::Key, &Err(SttFailure::Auth));
        assert_eq!(keys.status().deepgram.state, KeyState::Rejected);
    }

    #[test]
    fn a_removed_key_opens_no_stream_and_the_keychain_is_asked_once() {
        let counting: &'static Counting = Box::leak(Box::default());
        let keys: &'static crate::provider_keys::Keys = Box::leak(Box::new(
            crate::provider_keys::Keys::new(Box::new(counting), Box::new(Offline)),
        ));
        let fake = Fake::default();
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            Token::from_keys(keys),
            Duration::from_secs(60),
            Timing {
                // Long enough that only an immediate stop passes.
                token_wait: Duration::from_secs(30),
                ..Timing::default()
            },
        );
        stream.push(&[0.25; FRAME]).unwrap();
        let events = stream.finish(Duration::from_secs(2));
        // Said as the key, not as development settings, and at once.
        assert!(events.contains(&SttEvent::Failed(SttFailure::KeyUnavailable)));
        assert!(fake.0.lock().unwrap().url.is_none());
        assert_eq!(counting.1.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_sessions_replacement_streams_share_its_minute_budget() {
        // A one-second budget: the first stream spends it; the replacement
        // made from the same session's streams sends nothing more.
        let fake = Fake::default();
        let (opener, mut reopener) = key_streams_with(
            fake.clone(),
            || Token::from("t".repeat(24)),
            Budget::new(Duration::from_secs(1)),
            Language::English,
        );
        let mut first = opener().unwrap();
        first.push(&[0.1; SAMPLE_RATE]).unwrap();
        let _ = first.finish(Duration::from_secs(2));
        let sent = fake.0.lock().unwrap().binary.iter().sum::<usize>();
        assert_eq!(sent, SAMPLE_RATE * 2);
        let mut replacement = reopener().unwrap();
        replacement.push(&[0.1; FRAME]).unwrap();
        let mut events = Vec::new();
        let until = Instant::now() + Duration::from_secs(5);
        while !events.contains(&SttEvent::Failed(SttFailure::CapReached)) && Instant::now() < until
        {
            events.extend(replacement.poll());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(events.contains(&SttEvent::Failed(SttFailure::CapReached)));
        assert_eq!(fake.0.lock().unwrap().binary.iter().sum::<usize>(), sent);
    }

    #[test]
    fn audio_goes_out_in_100_ms_linear16_frames_and_finish_flushes_and_closes() {
        let fake = Fake::default();
        let mut stream = DeepgramStream::start(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
        );
        stream.push(&[0.1; 4_000]).unwrap();
        let _ = stream.finish(Duration::from_secs(2));
        let wire = fake.0.lock().unwrap();
        assert_eq!(
            wire.binary,
            vec![3_200, 3_200, 1_600],
            "two full frames and the rest"
        );
        assert_eq!(
            wire.text.last().map(String::as_str),
            Some(r#"{"type":"CloseStream"}"#)
        );
    }

    #[test]
    fn finals_carry_audio_times_and_an_untrusted_speaker_and_partials_carry_nothing() {
        let fake = Fake::default();
        fake.0.lock().unwrap().replies.extend([
            Ok(Some(r#"{"type":"Metadata"}"#.into())),
            Ok(Some(result("Fictional partial", false, 0.0, &[0]))),
            Ok(Some(result("Fictional final line.", true, 2.0, &[1, 1, 0]))),
            Ok(Some(result("", true, 3.5, &[]))),
        ]);
        let mut stream = DeepgramStream::start(
            fake,
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
        );
        let events = wait_for(&mut stream, |e| e.len() >= 3);
        assert!(matches!(events[0], SttEvent::Connected { .. }));
        assert_eq!(events[1], SttEvent::Partial);
        assert_eq!(
            events[2],
            SttEvent::Final {
                seq: 1,
                text: "Fictional final line.".into(),
                start_ms: 2_000,
                end_ms: 2_100,
                untrusted_speaker: Some(1),
            }
        );
    }

    #[test]
    fn handshake_refusals_and_protocol_errors_are_fixed_codes() {
        assert_eq!(handshake_failure(401), SttFailure::Auth);
        assert_eq!(handshake_failure(403), SttFailure::Auth);
        assert_eq!(handshake_failure(402), SttFailure::Quota);
        assert_eq!(handshake_failure(429), SttFailure::RateLimited);
        // A server error is the provider's outage, not the person's network.
        assert_eq!(handshake_failure(500), SttFailure::Unavailable);
        assert_eq!(handshake_failure(503), SttFailure::Unavailable);
        assert_eq!(handshake_failure(418), SttFailure::Network);
        let mut stream = DeepgramStream::start(
            Fake(Default::default(), Some(SttFailure::Auth)),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
        );
        let events = wait_for(&mut stream, |e| !e.is_empty());
        assert_eq!(events, vec![SttEvent::Failed(SttFailure::Auth)]);
        let mut seq = 0;
        assert_eq!(
            parse(r#"{"type":"Error","description":"x"}"#, &mut seq),
            Err(SttFailure::Protocol)
        );
        assert_eq!(parse("not json", &mut seq), Err(SttFailure::Protocol));
    }

    /// An owner-only folder and an empty placeholder token file in it, as
    /// the lab launcher leaves them before the review.
    #[cfg(unix)]
    fn placeholder() -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        // Unique per call: two tests can read the same clock value.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "talkqte-stt-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let file = dir.join("stt-token");
        std::fs::write(&file, "").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        (dir, file)
    }

    #[cfg(unix)]
    #[test]
    fn a_token_handed_over_after_approval_is_waited_for_and_the_audio_kept() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, file) = placeholder();
        // The placeholder passes the start-time check without being read.
        assert_eq!(super::super::cloud::check_token_file(&file), Ok(()));
        let fake = Fake::default();
        let mut stream = DeepgramStream::start(
            fake.clone(),
            ListenRequest::lab(),
            Token::from_file(file.clone()),
            Duration::from_secs(60),
        );
        // Speech after approval, before the token: kept, not sent yet.
        for _ in 0..5 {
            stream.push(&[0.1; FRAME]).unwrap();
        }
        std::thread::sleep(Duration::from_millis(200));
        assert!(fake.0.lock().unwrap().url.is_none(), "no connection yet");
        // The lab writes the token beside it and renames it over the placeholder.
        let next = dir.join("stt-token.next");
        std::fs::write(&next, "fictional.token_".to_string() + &"z".repeat(30)).unwrap();
        std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::rename(&next, &file).unwrap();
        let events = wait_for(&mut stream, |e| {
            e.iter().any(|e| matches!(e, SttEvent::Connected { .. }))
        });
        // The query actually used, with the opt-out and without the token.
        assert!(events.contains(&SttEvent::Connected {
            query: QUERY.to_string()
        }));
        assert!(QUERY.split('&').any(|p| p == "mip_opt_out=true"));
        let _ = stream.finish(Duration::from_secs(2));
        assert_eq!(fake.0.lock().unwrap().binary.len(), 5, "nothing was lost");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_token_that_never_arrives_stops_the_stream_with_settings() {
        let (dir, file) = placeholder();
        let fake = Fake::default();
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            Token::from_file(file),
            Duration::from_secs(60),
            Timing {
                token_wait: Duration::from_millis(150),
                ..Timing::default()
            },
        );
        stream.push(&[0.1; FRAME]).unwrap();
        let events = wait_for(&mut stream, |e| !e.is_empty());
        assert_eq!(events, vec![SttEvent::Failed(SttFailure::Settings)]);
        assert!(fake.0.lock().unwrap().url.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queued_audio_stops_going_out_as_soon_as_the_stream_is_stopped() {
        let fake = Fake::default();
        fake.0.lock().unwrap().send_delay = Duration::from_millis(20);
        let mut stream = DeepgramStream::start(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
        );
        // About 6 s of audio queued, which takes over a second to send.
        for _ in 0..64 {
            stream.push(&[0.1; FRAME]).unwrap();
        }
        let until = Instant::now() + Duration::from_secs(5);
        while fake.0.lock().unwrap().binary.is_empty() {
            assert!(Instant::now() < until, "nothing was sent");
            std::thread::sleep(Duration::from_millis(2));
        }
        stream.abort();
        std::thread::sleep(Duration::from_millis(300));
        let wire = fake.0.lock().unwrap();
        assert!(
            wire.binary.len() < 10,
            "{} frames went out",
            wire.binary.len()
        );
        assert!(wire.closed);
    }

    /// Short timings so the stall tests run in well under a second.
    fn quick() -> Timing {
        Timing {
            quiet_probe: Duration::from_millis(100),
            stall_after: Duration::from_millis(250),
            slow_write: Duration::from_millis(60),
            ..Timing::default()
        }
    }

    #[test]
    fn a_stream_that_takes_audio_but_never_answers_is_probed_then_stopped_as_stalled() {
        let fake = Fake::default();
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
            quick(),
        );
        // Audio keeps going out; Deepgram never says anything back.
        let until = Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        while !events.contains(&SttEvent::Failed(SttFailure::Stalled)) {
            assert!(Instant::now() < until, "never stopped: {events:?}");
            let _ = stream.push(&[0.1; FRAME]);
            events.extend(stream.poll());
            std::thread::sleep(Duration::from_millis(10));
        }
        let wire = fake.0.lock().unwrap();
        // It asked for a reply once before giving up, and closed the socket.
        assert_eq!(
            wire.text.iter().filter(|t| t.contains("Finalize")).count(),
            1,
            "{:?}",
            wire.text
        );
        assert!(wire.closed);
    }

    thread_local! {
        static SCRIPT_TIME: std::cell::Cell<Instant> = std::cell::Cell::new(Instant::now());
    }

    // A synchronous socket script owns audio, reply delivery and logical time.
    // Caller scheduling and wall-clock pauses cannot invent a network stall.
    fn scripted_quiet_spell(answer: bool) -> (Vec<SttEvent>, usize, usize, bool) {
        struct Script {
            audio: SyncSender<Vec<f32>>,
            stop: Arc<AtomicBool>,
            state: Arc<Mutex<(usize, usize, bool)>>,
            answer: bool,
        }
        impl Connector for Script {
            fn connect(&self, _: &str, _: &str) -> Result<Box<dyn Socket>, SttFailure> {
                Ok(Box::new(Script {
                    audio: self.audio.clone(),
                    stop: self.stop.clone(),
                    state: self.state.clone(),
                    answer: self.answer,
                }))
            }
        }
        impl Socket for Script {
            fn send_binary(&mut self, _: Vec<u8>) -> Result<(), SttFailure> {
                Ok(())
            }
            fn send_text(&mut self, text: &str) -> Result<(), SttFailure> {
                assert_eq!(text, r#"{"type":"Finalize"}"#);
                self.state.lock().unwrap().1 += 1;
                Ok(())
            }
            fn recv(&mut self) -> Result<Option<String>, SttFailure> {
                SCRIPT_TIME.with(|t| t.set(t.get() + Duration::from_millis(75)));
                let mut state = self.state.lock().unwrap();
                state.0 += 1;
                // Each quiet spell crosses the100ms probe but stays below250ms.
                if state.0 == 12 {
                    self.stop.store(true, Ordering::Release);
                }
                self.audio.try_send(vec![0.1; FRAME]).unwrap();
                Ok((self.answer && state.0.is_multiple_of(3))
                    .then(|| r#"{"type":"Metadata"}"#.into()))
            }
            fn close(&mut self) {
                self.state.lock().unwrap().2 = true;
            }
        }
        SCRIPT_TIME.with(|t| t.set(Instant::now()));
        let (audio, queue) = mpsc::sync_channel(QUEUE);
        audio.send(vec![0.1; FRAME]).unwrap();
        let (tx, events) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new((0, 0, false)));
        run(
            Script {
                audio,
                stop: stop.clone(),
                state: state.clone(),
                answer,
            },
            ListenRequest::lab(),
            Token::from("t".repeat(24)),
            Duration::from_secs(60).into(),
            Timing {
                now: || SCRIPT_TIME.with(|t| t.get()),
                ..quick()
            },
            queue,
            tx,
            stop,
        );
        let (reads, probes, closed) = *state.lock().unwrap();
        (events.try_iter().collect(), reads, probes, closed)
    }

    #[test]
    fn a_reply_keeps_the_stream_alive_through_a_quiet_spell() {
        let (events, reads, probes, closed) = scripted_quiet_spell(true);
        assert_eq!(
            events,
            vec![SttEvent::Connected {
                query: QUERY.into()
            }]
        );
        assert_eq!((reads, probes, closed), (12, 4, true));
    }

    #[test]
    fn the_same_quiet_spell_without_replies_is_probed_then_stalled() {
        let (events, reads, probes, closed) = scripted_quiet_spell(false);
        assert_eq!(
            events,
            vec![
                SttEvent::Connected {
                    query: QUERY.into()
                },
                SttEvent::Failed(SttFailure::Stalled)
            ]
        );
        assert_eq!((reads, probes, closed), (4, 1, true));
    }

    #[test]
    fn a_write_that_takes_too_long_stops_the_stream_as_stalled() {
        let fake = Fake::default();
        fake.0.lock().unwrap().send_delay = Duration::from_millis(120);
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
            quick(),
        );
        stream.push(&[0.1; FRAME]).unwrap();
        let events = wait_for(&mut stream, |e| {
            e.contains(&SttEvent::Failed(SttFailure::Stalled))
        });
        assert!(events.contains(&SttEvent::Failed(SttFailure::Stalled)));
        assert!(fake.0.lock().unwrap().closed);
    }

    #[test]
    fn a_socket_that_falls_behind_backs_audio_up_in_the_bounded_queue_not_without_limit() {
        // Audio arrives every 5 ms and each frame takes 20 ms to send: the
        // socket thread holds at most two seconds, the queue fills, and
        // later audio is refused (the feed counts and discloses it) instead
        // of collecting without limit on the socket thread.
        let fake = Fake::default();
        fake.0.lock().unwrap().send_delay = Duration::from_millis(20);
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(600),
            Timing::default(),
        );
        let mut refused = 0;
        for _ in 0..400 {
            if stream.push(&[0.1; FRAME]).is_err() {
                refused += 1;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let sent = fake.0.lock().unwrap().binary.len();
        assert!(refused > 0, "nothing was refused; {sent} frames sent");
        // Everything accepted is either sent, queued, or among the two
        // seconds held on the socket thread.
        assert!(400 - refused <= sent + QUEUE + MAX_PENDING_SAMPLES / FRAME + 1);
        stream.abort();
    }

    /// How many frames had gone out when a reply, arriving while 3 s of
    /// audio was backed up, was read.
    fn frames_before_reply(frames_per_read: usize) -> usize {
        let fake = Fake::default();
        fake.0.lock().unwrap().send_delay = Duration::from_millis(5);
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
            Timing {
                frames_per_read,
                ..Timing::default()
            },
        );
        for _ in 0..30 {
            stream.push(&[0.1; FRAME]).unwrap();
        }
        fake.0.lock().unwrap().replies.push_back(Ok(Some(result(
            "Fictional line.",
            true,
            0.0,
            &[0],
        ))));
        wait_for(&mut stream, |e| {
            e.iter().any(|e| matches!(e, SttEvent::Final { .. }))
        });
        let at = fake.0.lock().unwrap().binary_at_first_reply.unwrap();
        at
    }

    #[test]
    fn replies_are_read_between_seconds_of_backed_up_audio() {
        // With a second of frames between reads, the reply is read long
        // before the backlog is gone; without a limit, only after all the
        // socket thread holds (two seconds; the rest waits in the queue).
        assert!(frames_before_reply(FRAMES_PER_READ) < 20);
        assert_eq!(frames_before_reply(usize::MAX), MAX_PENDING_SAMPLES / FRAME);
    }

    #[test]
    fn two_streams_of_one_launch_share_its_minute_cap() {
        let budget = Budget::new(Duration::from_secs(1));
        let first = Fake::default();
        let mut stream = DeepgramStream::start(
            first.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            budget.clone(),
        );
        stream.push(&[0.1; SAMPLE_RATE]).unwrap();
        let _ = stream.finish(Duration::from_secs(2));
        assert_eq!(
            first.0.lock().unwrap().binary.iter().sum::<usize>(),
            SAMPLE_RATE * 2
        );
        // The launch's minute is spent: a later stream sends nothing.
        let second = Fake::default();
        let mut later =
            DeepgramStream::start(second.clone(), ListenRequest::lab(), "t".repeat(24), budget);
        later.push(&[0.1; FRAME]).unwrap();
        let events = wait_for(&mut later, |e| {
            e.contains(&SttEvent::Failed(SttFailure::CapReached))
        });
        assert!(events.contains(&SttEvent::Failed(SttFailure::CapReached)));
        assert!(second.0.lock().unwrap().binary.is_empty());
    }

    #[test]
    fn the_minute_cap_stops_sending_and_reports_why() {
        let fake = Fake::default();
        // A one-minute cap, then 61 s of audio: exactly 60 s is sent.
        let mut stream = DeepgramStream::start(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
        );
        for _ in 0..61 {
            stream.push(&[0.1; SAMPLE_RATE]).unwrap();
        }
        let events = wait_for(&mut stream, |e| {
            e.contains(&SttEvent::Failed(SttFailure::CapReached))
        });
        assert!(events.contains(&SttEvent::Failed(SttFailure::CapReached)));
        let wire = fake.0.lock().unwrap();
        assert_eq!(wire.binary.iter().sum::<usize>(), 60 * SAMPLE_RATE * 2);
        assert!(wire.text.iter().any(|t| t.contains("CloseStream")));
    }

    #[test]
    fn speech_without_a_final_is_finalized_and_silence_is_kept_alive() {
        let fake = Fake::default();
        fake.0.lock().unwrap().replies.push_back(Ok(Some(result(
            "A speaker who runs on",
            false,
            0.0,
            &[0],
        ))));
        let timing = Timing {
            keep_alive: Duration::from_millis(60),
            finalize_after: Duration::from_millis(80),
            ..Timing::default()
        };
        let mut stream = DeepgramStream::start_with(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
            timing,
        );
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let text = fake.0.lock().unwrap().text.clone();
            let finalized = text.iter().filter(|t| t.contains("Finalize")).count();
            if finalized == 1 && text.iter().any(|t| t.contains("KeepAlive")) {
                break;
            }
            assert!(Instant::now() < until, "{text:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
        // One Finalize per run of speech without a final, not a stream of them.
        std::thread::sleep(Duration::from_millis(200));
        let text = fake.0.lock().unwrap().text.clone();
        assert_eq!(text.iter().filter(|t| t.contains("Finalize")).count(), 1);
        stream.abort();
    }

    #[test]
    fn a_lost_connection_is_reported_once_with_no_reconnect() {
        let fake = Fake::default();
        fake.0
            .lock()
            .unwrap()
            .replies
            .push_back(Err(SttFailure::Network));
        let mut stream = DeepgramStream::start(
            fake.clone(),
            ListenRequest::lab(),
            "t".repeat(24),
            Duration::from_secs(60),
        );
        let events = wait_for(&mut stream, |e| e.len() >= 2);
        assert!(matches!(events[0], SttEvent::Connected { .. }));
        assert_eq!(events[1..], [SttEvent::Failed(SttFailure::Network)]);
        std::thread::sleep(Duration::from_millis(50));
        assert!(stream.poll().is_empty());
        assert!(fake.0.lock().unwrap().url.is_some());
    }
}
