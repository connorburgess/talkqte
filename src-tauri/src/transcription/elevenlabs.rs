//! ElevenLabs Scribe v2 Realtime live streaming, a `StreamingTranscriber`.
//!
//! Connects to `wss://api.elevenlabs.io/v1/speech-to-text/realtime` over TLS
//! with the person's own ElevenLabs API key from the Keychain (`xi-api-key`
//! header, never in the URL or logs).
//!
//! A socket thread sends 100 ms 16 kHz mono PCM frames encoded as base64 in
//! `input_audio_chunk` JSON messages, commits speech that runs 6 s without a
//! final, and sends a final commit on Stop or at the minute cap.

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

pub const MODEL_ID: &str = "scribe_v2_realtime";
/// English: explicit `language_code=en` hint alongside VAD commits and word timestamps.
pub const QUERY_EN: &str = "model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&include_timestamps=true&language_code=en";
/// Multilingual: omits `language_code` so Scribe v2 Realtime detects languages automatically.
pub const QUERY_MULTI: &str = "model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&include_timestamps=true";

const HOST: &str = "api.elevenlabs.io";
const PATH: &str = "/v1/speech-to-text/realtime";
/// Samples per frame sent: 100 ms at 16 kHz.
const FRAME: usize = SAMPLE_RATE / 10;
/// Speech that has gone this long without a final is committed by request,
/// so a speaker who runs on does not hold a line back indefinitely.
pub const FINALIZE_AFTER: Duration = Duration::from_secs(6);
/// Blocks waiting to be sent before new audio is dropped (about 12.8 s).
const QUEUE: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RealtimeRequest {
    language: Language,
}

impl RealtimeRequest {
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
        format!("wss://{HOST}{PATH}?{}", self.query())
    }
}

/// Refuses a URL missing required Scribe v2 Realtime parameters or carrying a
/// credential query parameter.
fn checked(url: &str) -> Result<&str, SttFailure> {
    let prefix = format!("wss://{HOST}{PATH}?");
    let Some(query) = url.strip_prefix(&prefix) else {
        return Err(SttFailure::Protocol);
    };
    let mut has_model = false;
    let mut has_format = false;
    let mut has_commit = false;
    let mut has_timestamps = false;
    for param in query.split('&') {
        if param.starts_with("token=") || param.starts_with("xi-api-key=") {
            return Err(SttFailure::Protocol);
        }
        match param {
            "model_id=scribe_v2_realtime" => has_model = true,
            "audio_format=pcm_16000" => has_format = true,
            "commit_strategy=vad" => has_commit = true,
            "include_timestamps=true" => has_timestamps = true,
            _ => {}
        }
    }
    if has_model && has_format && has_commit && has_timestamps {
        Ok(url)
    } else {
        Err(SttFailure::Protocol)
    }
}

/// One open stream's transport. Tests supply a fake; nothing in tests
/// reaches the network.
pub trait Socket: Send {
    fn send_text(&mut self, text: &str) -> Result<(), SttFailure>;
    /// A text message if one arrives within a short wait, else None.
    fn recv(&mut self) -> Result<Option<String>, SttFailure>;
    fn close(&mut self);
}

pub trait Connector: Send + 'static {
    fn connect(&self, url: &str, key: &str) -> Result<Box<dyn Socket>, SttFailure>;
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

pub struct ElevenLabsStream {
    audio: Option<SyncSender<Vec<f32>>>,
    events: Receiver<SttEvent>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ElevenLabsStream {
    /// Starts the socket thread. The key is read once on that thread when
    /// connecting and dropped immediately after the handshake.
    pub fn start(
        connector: impl Connector,
        request: RealtimeRequest,
        key: impl Into<KeySource>,
        budget: impl Into<Budget>,
    ) -> Self {
        Self::start_with(connector, request, key, budget, Timing::default())
    }

    fn start_with(
        connector: impl Connector,
        request: RealtimeRequest,
        key: impl Into<KeySource>,
        budget: impl Into<Budget>,
        timing: Timing,
    ) -> Self {
        let budget = budget.into();
        let key = key.into();
        let (audio, queue) = mpsc::sync_channel(QUEUE);
        let (tx, events) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("talkqte-elevenlabs-transcription".into())
            .spawn(move || run(connector, request, key, budget, timing, queue, tx, flag))
            .ok();
        Self {
            audio: Some(audio),
            events,
            stop,
            thread,
        }
    }
}

impl StreamingTranscriber for ElevenLabsStream {
    fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
        let audio = self.audio.as_ref().ok_or(Full)?;
        audio.try_send(samples.to_vec()).map_err(|_| Full)
    }

    fn poll(&mut self) -> Vec<SttEvent> {
        self.events.try_iter().collect()
    }

    fn finish(&mut self, wait: Duration) -> Vec<SttEvent> {
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

impl Drop for ElevenLabsStream {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Clone, Copy)]
struct Timing {
    finalize_after: Duration,
    quiet_probe: Duration,
    stall_after: Duration,
    slow_write: Duration,
    close_wait: Duration,
    idle_close_wait: Duration,
    frames_per_read: usize,
    #[cfg(test)]
    now: fn() -> Instant,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            finalize_after: FINALIZE_AFTER,
            quiet_probe: QUIET_PROBE,
            stall_after: STALL_AFTER,
            slow_write: SLOW_WRITE,
            close_wait: CLOSE_WAIT,
            idle_close_wait: IDLE_CLOSE_WAIT,
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

const QUIET_PROBE: Duration = Duration::from_secs(5);
const STALL_AFTER: Duration = Duration::from_secs(10);
const SLOW_WRITE: Duration = Duration::from_secs(3);
const CLOSE_WAIT: Duration = Duration::from_secs(5);
const IDLE_CLOSE_WAIT: Duration = Duration::from_millis(300);
const FRAMES_PER_READ: usize = 10;
const MAX_PENDING_SAMPLES: usize = FRAME * 20;

/// Encodes PCM bytes into standard RFC 4648 base64 for `input_audio_chunk`.
pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = *chunk.get(1).unwrap_or(&0) as usize;
        let b2 = *chunk.get(2).unwrap_or(&0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) & 0x3f] as char);
        out.push(TABLE[(triple >> 12) & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

fn audio_chunk_message(samples: &[i16], commit: bool) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let audio_base_64 = encode_base64(&bytes);
    format!(
        r#"{{"message_type":"input_audio_chunk","audio_base_64":"{audio_base_64}","commit":{commit},"sample_rate":{SAMPLE_RATE}}}"#
    )
}

#[allow(clippy::too_many_arguments)]
fn run(
    connector: impl Connector,
    request: RealtimeRequest,
    mut key_source: KeySource,
    budget: Budget,
    timing: Timing,
    queue: Receiver<Vec<f32>>,
    events: mpsc::Sender<SttEvent>,
    stop: Arc<AtomicBool>,
) {
    if stop.load(Ordering::Acquire) {
        return;
    }
    let key = match key_source.take() {
        Ok(key) => key,
        Err(failure) => {
            let _ = events.send(SttEvent::Failed(failure));
            return;
        }
    };
    let url = request.url();
    let socket = checked(&url).and_then(|url| connector.connect(url, &key));
    drop(key);
    let mut socket = match socket {
        Ok(socket) => socket,
        Err(failure) => {
            if failure == SttFailure::Auth && !stop.load(Ordering::Acquire) {
                key_source.note_rejected();
            }
            let _ = events.send(SttEvent::Failed(failure));
            return;
        }
    };
    let query = url.split_once('?').map_or("", |(_, query)| query);
    let _ = events.send(SttEvent::Connected {
        query: query.to_string(),
    });

    let mut pending: Vec<i16> = Vec::with_capacity(FRAME * 2);
    let mut sent_samples: u64 = 0;
    let mut sent_any_audio = false;
    let mut awaiting_commit = false;
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
                if stop.load(Ordering::Acquire) {
                    socket.close();
                    return;
                }
                let take = budget.reserve(pending.len().min(FRAME) as u64) as usize;
                if take == 0 {
                    cap_reached = true;
                    break;
                }
                let frame: Vec<i16> = pending.drain(..take).collect();
                let payload = audio_chunk_message(&frame, false);
                let started = timing.now();
                if let Err(failure) = socket.send_text(&payload) {
                    let _ = events.send(SttEvent::Failed(failure));
                    return;
                }
                if timing.elapsed(started) > timing.slow_write {
                    let _ = events.send(SttEvent::Failed(SttFailure::Stalled));
                    socket.close();
                    return;
                }
                sent_samples += take as u64;
                sent_any_audio = true;
                awaiting_commit = true;
                sent_since_heard = true;
                sent_frames += 1;
            }
            if sent_since_heard && timing.elapsed(last_heard) >= timing.stall_after {
                let _ = events.send(SttEvent::Failed(SttFailure::Stalled));
                socket.close();
                return;
            }
            if sent_since_heard && !probed && timing.elapsed(last_heard) >= timing.quiet_probe {
                probed = true;
                let commit = audio_chunk_message(&[], true);
                if socket.send_text(&commit).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
            }
            if cap_reached || closing.is_some() {
                let closed_at = *closing.get_or_insert_with(|| timing.now());
                if !sent_any_audio {
                    socket.close();
                    if cap_reached {
                        let _ = events.send(SttEvent::Failed(SttFailure::CapReached));
                    }
                    return;
                }
                let commit = audio_chunk_message(&[], true);
                if socket.send_text(&commit).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
                let _ = closed_at;
            } else if unfinalized
                .is_some_and(|since| timing.elapsed(since) >= timing.finalize_after)
            {
                let commit = audio_chunk_message(&[], true);
                if socket.send_text(&commit).is_err() {
                    let _ = events.send(SttEvent::Failed(SttFailure::Network));
                    return;
                }
                unfinalized = None;
            }
        } else if closing.is_some_and(|at| {
            timing.elapsed(at) > timing.close_wait
                || (!awaiting_commit && timing.elapsed(at) >= timing.idle_close_wait)
        }) {
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
        let fallback_ms = sent_samples * 1_000 / SAMPLE_RATE as u64;
        match reply {
            Ok(Some(text)) => match parse(&text, &mut seq, fallback_ms) {
                Ok(Some(event)) => {
                    let is_final = matches!(event, SttEvent::Final { .. });
                    match &event {
                        SttEvent::Final { .. } => {
                            unfinalized = None;
                            awaiting_commit = false;
                        }
                        SttEvent::Partial => {
                            awaiting_commit = true;
                            unfinalized.get_or_insert_with(|| timing.now());
                        }
                        SttEvent::Failed(_) | SttEvent::Connected { .. } => {}
                    }
                    if events.send(event).is_err() {
                        socket.close();
                        return;
                    }
                    if closing.is_some() && is_final {
                        // Drain any remaining immediate messages and close.
                        while let Ok(Some(extra)) = socket.recv() {
                            if let Ok(Some(ev)) = parse(&extra, &mut seq, fallback_ms) {
                                let _ = events.send(ev);
                            }
                        }
                        socket.close();
                        if cap_reached {
                            let _ = events.send(SttEvent::Failed(SttFailure::CapReached));
                        }
                        return;
                    }
                }
                Ok(None) => {}
                Err(failure) => {
                    if failure == SttFailure::Auth && !stop.load(Ordering::Acquire) {
                        key_source.note_rejected();
                    }
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
                if failure == SttFailure::Auth && !stop.load(Ordering::Acquire) {
                    key_source.note_rejected();
                }
                let _ = events.send(SttEvent::Failed(failure));
                return;
            }
        }
    }
}

/// One ElevenLabs server message as an event.
///
/// With `include_timestamps=true`, ElevenLabs emits both `committed_transcript`
/// and `committed_transcript_with_timestamps` for the same segment; only
/// `committed_transcript_with_timestamps` emits `SttEvent::Final` so lines are
/// never duplicated. Provider error text is never echoed.
pub(crate) fn parse(
    text: &str,
    seq: &mut u64,
    fallback_ms: u64,
) -> Result<Option<SttEvent>, SttFailure> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| SttFailure::Protocol)?;
    let Some(message_type) = value.get("message_type").and_then(|t| t.as_str()) else {
        return Err(SttFailure::Protocol);
    };
    match message_type {
        "session_started" | "committed_transcript" => Ok(None),
        "partial_transcript" => {
            let transcript = value
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim();
            if transcript.is_empty() {
                Ok(None)
            } else {
                Ok(Some(SttEvent::Partial))
            }
        }
        "committed_transcript_with_timestamps" => {
            let transcript = value
                .get("text")
                .and_then(|t| t.as_str())
                .ok_or(SttFailure::Protocol)?
                .trim();
            if transcript.is_empty() {
                return Ok(None);
            }
            let words = value.get("words").and_then(|w| w.as_array());
            let word_time = |word: &serde_json::Value, key: &str| {
                if word.get("type").and_then(|t| t.as_str()) == Some("spacing") {
                    return None;
                }
                word.get(key)
                    .and_then(|v| v.as_f64())
                    .filter(|t| t.is_finite() && *t >= 0.0)
            };
            let first = words.and_then(|w| w.iter().find_map(|item| word_time(item, "start")));
            let last = words.and_then(|w| w.iter().rev().find_map(|item| word_time(item, "end")));
            let (start_ms, end_ms) = match (first, last) {
                (Some(from), Some(to)) if from <= to => {
                    ((from * 1_000.0) as u64, (to * 1_000.0) as u64)
                }
                _ => (fallback_ms, fallback_ms),
            };
            *seq += 1;
            Ok(Some(SttEvent::Final {
                seq: *seq,
                text: transcript.chars().take(1_000).collect(),
                start_ms,
                end_ms,
                untrusted_speaker: None,
            }))
        }
        "auth_error" => Err(SttFailure::Auth),
        "quota_exceeded" => Err(SttFailure::Quota),
        "rate_limited" => Err(SttFailure::RateLimited),
        "transcriber_error" => Err(SttFailure::Unavailable),
        "session_time_limit_exceeded" => Err(SttFailure::Closed),
        other
            if other.ends_with("_error")
                || matches!(
                    other,
                    "error"
                        | "invalid_request"
                        | "queue_overflow"
                        | "chunk_size_exceeded"
                        | "commit_throttled"
                        | "unaccepted_terms"
                ) =>
        {
            Err(SttFailure::Protocol)
        }
        _ => Ok(None),
    }
}

/// The stream and its replacements for one session with the person's own
/// ElevenLabs key: both draw on the one `budget` made for that session.
pub fn key_streams(
    budget: Budget,
    language: Language,
) -> (super::cloud::Opener, super::cloud::Reopener) {
    key_streams_with(Network, KeySource::from_keychain, budget, language)
}

fn key_streams_with<C: Connector + Clone>(
    connector: C,
    key: fn() -> KeySource,
    budget: Budget,
    language: Language,
) -> (super::cloud::Opener, super::cloud::Reopener) {
    let first = (connector.clone(), budget.clone());
    let opener: super::cloud::Opener = Box::new(move || {
        Ok(Box::new(ElevenLabsStream::start(
            first.0,
            RealtimeRequest::for_language(language),
            key(),
            first.1,
        )) as Box<dyn StreamingTranscriber>)
    });
    let reopener: super::cloud::Reopener = Box::new(move || {
        Ok(Box::new(ElevenLabsStream::start(
            connector.clone(),
            RealtimeRequest::for_language(language),
            key(),
            budget.clone(),
        )) as Box<dyn StreamingTranscriber>)
    });
    (opener, reopener)
}

/// Where the socket thread gets the ElevenLabs API key, and where it marks it
/// rejected on a 401/403 or `auth_error`.
pub struct KeySource {
    read: Box<dyn FnMut() -> Result<Zeroizing<String>, SttFailure> + Send>,
    reject: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl KeySource {
    pub fn from_keychain() -> Self {
        Self::from_keys(crate::provider_keys::global())
    }

    fn from_keys(keys: &'static crate::provider_keys::Keys) -> Self {
        let source = keys.request_key(crate::provider_keys::Provider::ElevenLabs);
        let rejected_source = source.clone();
        Self {
            read: Box::new(move || {
                source
                    .get()
                    .map(|key| Zeroizing::new(key.expose().to_string()))
                    .map_err(|_| SttFailure::KeyUnavailable)
            }),
            reject: Some(Arc::new(move || {
                rejected_source.mark_rejected();
            })),
        }
    }

    fn take(&mut self) -> Result<Zeroizing<String>, SttFailure> {
        (self.read)()
    }

    fn note_rejected(&self) {
        if let Some(reject) = &self.reject {
            reject();
        }
    }
}

impl From<String> for KeySource {
    fn from(key: String) -> Self {
        let mut key = Some(Zeroizing::new(key));
        Self {
            read: Box::new(move || key.take().ok_or(SttFailure::KeyUnavailable)),
            reject: None,
        }
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The network connector: TLS with the bundled web roots, a WebSocket
/// handshake carrying the key in the `xi-api-key` header, then short read
/// waits.
#[derive(Clone)]
pub struct Network;

impl Connector for Network {
    fn connect(&self, url: &str, key: &str) -> Result<Box<dyn Socket>, SttFailure> {
        self.connect_inner(url, key)
    }
}

impl Network {
    fn connect_inner(&self, url: &str, key: &str) -> Result<Box<dyn Socket>, SttFailure> {
        use tungstenite::client::IntoClientRequest;
        let mut request = url
            .into_client_request()
            .map_err(|_| SttFailure::Protocol)?;
        let mut value =
            tungstenite::http::HeaderValue::from_str(key).map_err(|_| SttFailure::Settings)?;
        value.set_sensitive(true);
        request.headers_mut().insert("xi-api-key", value);
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

    const FICTIONAL_KEY: &str = "sk_fictional0123456789abcdef0123456789abcdef01234567";

    #[derive(Default)]
    struct Wire {
        url: Option<String>,
        key: Option<String>,
        text: Vec<String>,
        replies: std::collections::VecDeque<Result<Option<String>, SttFailure>>,
        closed: bool,
        send_delay: Duration,
        close_on_commit: bool,
        reply_on_commit: Option<String>,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<Wire>>, Option<SttFailure>);

    impl Connector for Fake {
        fn connect(&self, url: &str, key: &str) -> Result<Box<dyn Socket>, SttFailure> {
            if let Some(failure) = self.1 {
                return Err(failure);
            }
            let mut wire = self.0.lock().unwrap();
            wire.url = Some(url.into());
            wire.key = Some(key.into());
            Ok(Box::new(self.clone()))
        }
    }

    impl Socket for Fake {
        fn send_text(&mut self, text: &str) -> Result<(), SttFailure> {
            let delay = self.0.lock().unwrap().send_delay;
            std::thread::sleep(delay);
            let mut wire = self.0.lock().unwrap();
            wire.text.push(text.into());
            if text.contains(r#""commit":true"#) {
                if let Some(reply) = wire.reply_on_commit.take() {
                    wire.replies.push_back(Ok(Some(reply)));
                }
                if wire.close_on_commit {
                    wire.replies.push_back(Err(SttFailure::Closed));
                }
            }
            Ok(())
        }
        fn recv(&mut self) -> Result<Option<String>, SttFailure> {
            std::thread::sleep(Duration::from_millis(2));
            let mut wire = self.0.lock().unwrap();
            wire.replies.pop_front().unwrap_or(Ok(None))
        }
        fn close(&mut self) {
            self.0.lock().unwrap().closed = true;
        }
    }

    fn wait_for(
        stream: &mut ElevenLabsStream,
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
    fn held_auth_handshake_cannot_reject_replacement_or_aborted_stream() {
        use crate::provider_keys::{
            KeyState, Keys, MemoryStore, Probe, ProbeResult, Provider, Secret,
        };
        use std::sync::mpsc;
        struct Offline;
        impl Probe for Offline {
            fn check(&self, _: Provider, _: &Secret) -> ProbeResult {
                panic!("no provider probe");
            }
        }
        struct Held {
            entered: mpsc::Sender<()>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl Connector for Held {
            fn connect(&self, _: &str, _: &str) -> Result<Box<dyn Socket>, SttFailure> {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                Err(SttFailure::Auth)
            }
        }
        const KEY: &str = "sk_fictional0123456789abcdef0123456789abcdef01234567";
        for boundary in ["current", "replace", "abort"] {
            let keys = Box::leak(Box::new(Keys::new(
                Box::<MemoryStore>::default(),
                Box::new(Offline),
            )));
            keys.set(Provider::ElevenLabs, KEY).unwrap();
            let (entered, started) = mpsc::channel();
            let (release, held) = mpsc::channel();
            let connector = Held {
                entered,
                release: Mutex::new(held),
            };
            let mut stream = ElevenLabsStream::start(
                connector,
                RealtimeRequest::for_language(Language::English),
                KeySource::from_keys(keys),
                Duration::from_secs(60),
            );
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            if boundary == "replace" {
                keys.set(Provider::ElevenLabs, &format!("{KEY}replacement"))
                    .unwrap();
            }
            if boundary == "abort" {
                stream.abort();
            }
            release.send(()).unwrap();
            wait_for(&mut stream, |events| {
                events.contains(&SttEvent::Failed(SttFailure::Auth))
            });
            assert_eq!(
                keys.status().of(Provider::ElevenLabs).state,
                if boundary == "current" {
                    KeyState::Rejected
                } else {
                    KeyState::Set
                }
            );
            if let Some(thread) = stream.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    #[test]
    fn base64_encodes_rfc4648_vectors() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(encode_base64(&[0u8; 3_200]).len(), 4_268);
    }

    #[test]
    fn each_language_builds_expected_url_and_never_puts_key_in_url() {
        for (language, query) in [
            (Language::English, QUERY_EN),
            (Language::Multilingual, QUERY_MULTI),
        ] {
            let fake = Fake::default();
            fake.0.lock().unwrap().close_on_commit = true;
            let mut stream = ElevenLabsStream::start(
                fake.clone(),
                RealtimeRequest::for_language(language),
                FICTIONAL_KEY.to_string(),
                Duration::from_secs(60),
            );
            stream.push(&[0.25; FRAME]).unwrap();
            let events = stream.finish(Duration::from_secs(2));
            let wire = fake.0.lock().unwrap();
            let url = wire.url.as_deref().unwrap();
            assert_eq!(
                url,
                format!("wss://api.elevenlabs.io/v1/speech-to-text/realtime?{query}")
            );
            assert!(!url.contains(FICTIONAL_KEY));
            assert_eq!(wire.key.as_deref(), Some(FICTIONAL_KEY));
            assert!(events.contains(&SttEvent::Connected {
                query: query.to_string()
            }));
        }
        assert!(checked("wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&include_timestamps=true").is_ok());
        assert_eq!(
            checked("wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=secret"),
            Err(SttFailure::Protocol)
        );
        assert_eq!(
            checked("wss://other.example/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&include_timestamps=true"),
            Err(SttFailure::Protocol)
        );
    }

    #[test]
    fn audio_goes_out_as_base64_pcm_chunks_and_finish_commits_and_delivers_final() {
        let fake = Fake::default();
        {
            let mut wire = fake.0.lock().unwrap();
            wire.reply_on_commit = Some(
                serde_json::json!({
                    "message_type": "committed_transcript_with_timestamps",
                    "text": "Fictional final from commit.",
                    "words": [
                        {"text": "Fictional", "start": 0.0, "end": 0.1, "type": "word"},
                        {"text": " ", "start": 0.1, "end": 0.12, "type": "spacing"},
                        {"text": "commit.", "start": 0.12, "end": 0.24, "type": "word"}
                    ]
                })
                .to_string(),
            );
        }
        let mut stream = ElevenLabsStream::start(
            fake.clone(),
            RealtimeRequest::for_language(Language::English),
            FICTIONAL_KEY.to_string(),
            Duration::from_secs(60),
        );
        stream.push(&[0.1; 4_000]).unwrap();
        let events = stream.finish(Duration::from_secs(2));
        let wire = fake.0.lock().unwrap();
        // 4,000 samples = 1,600 + 1,600 + 800, then one final commit:true chunk.
        let audio_chunks: Vec<serde_json::Value> = wire
            .text
            .iter()
            .map(|t| serde_json::from_str(t).unwrap())
            .collect();
        assert_eq!(audio_chunks.len(), 4);
        assert_eq!(audio_chunks[0]["message_type"], "input_audio_chunk");
        assert_eq!(audio_chunks[0]["commit"], false);
        assert_eq!(audio_chunks[0]["sample_rate"], 16_000);
        assert_eq!(
            audio_chunks[0]["audio_base_64"].as_str().unwrap().len(),
            4_268
        );
        assert_eq!(
            audio_chunks[2]["audio_base_64"].as_str().unwrap().len(),
            2_136
        );
        assert_eq!(audio_chunks[3]["commit"], true);
        assert_eq!(audio_chunks[3]["audio_base_64"], "");
        assert!(wire.closed);
        assert!(events.contains(&SttEvent::Final {
            seq: 1,
            text: "Fictional final from commit.".into(),
            start_ms: 0,
            end_ms: 240,
            untrusted_speaker: None,
        }));
    }

    #[test]
    fn committed_transcript_duplicate_is_ignored_and_timestamps_variant_is_used() {
        let mut seq = 0;
        assert_eq!(
            parse(r#"{"message_type":"session_started"}"#, &mut seq, 0),
            Ok(None)
        );
        assert_eq!(
            parse(
                r#"{"message_type":"partial_transcript","text":"   "}"#,
                &mut seq,
                0
            ),
            Ok(None)
        );
        assert_eq!(
            parse(
                r#"{"message_type":"partial_transcript","text":"Fictional partial"}"#,
                &mut seq,
                0
            ),
            Ok(Some(SttEvent::Partial))
        );
        assert_eq!(
            parse(
                r#"{"message_type":"committed_transcript","text":"Fictional line."}"#,
                &mut seq,
                500
            ),
            Ok(None)
        );
        assert_eq!(
            parse(
                &serde_json::json!({
                    "message_type": "committed_transcript_with_timestamps",
                    "text": "Fictional line.",
                    "words": [
                        {"text": "Fictional", "start": 0.25, "end": 0.6, "type": "word"},
                        {"text": " ", "start": 0.6, "end": 0.62, "type": "spacing"},
                        {"text": "line.", "start": 0.62, "end": 0.95, "type": "word"}
                    ]
                })
                .to_string(),
                &mut seq,
                500
            ),
            Ok(Some(SttEvent::Final {
                seq: 1,
                text: "Fictional line.".into(),
                start_ms: 250,
                end_ms: 950,
                untrusted_speaker: None,
            }))
        );
        // Missing words falls back safely to stream time.
        assert_eq!(
            parse(
                r#"{"message_type":"committed_transcript_with_timestamps","text":"Fallback."}"#,
                &mut seq,
                1_200
            ),
            Ok(Some(SttEvent::Final {
                seq: 2,
                text: "Fallback.".into(),
                start_ms: 1_200,
                end_ms: 1_200,
                untrusted_speaker: None,
            }))
        );
    }

    #[test]
    fn errors_map_to_fixed_codes_without_provider_text_and_auth_marks_key_rejected() {
        let mut seq = 0;
        assert_eq!(
            parse(
                r#"{"message_type":"auth_error","error":"secret detail"}"#,
                &mut seq,
                0
            ),
            Err(SttFailure::Auth)
        );
        assert_eq!(
            parse(r#"{"message_type":"quota_exceeded"}"#, &mut seq, 0),
            Err(SttFailure::Quota)
        );
        assert_eq!(
            parse(r#"{"message_type":"rate_limited"}"#, &mut seq, 0),
            Err(SttFailure::RateLimited)
        );
        assert_eq!(
            parse(r#"{"message_type":"transcriber_error"}"#, &mut seq, 0),
            Err(SttFailure::Unavailable)
        );
        assert_eq!(
            parse(
                r#"{"message_type":"session_time_limit_exceeded"}"#,
                &mut seq,
                0
            ),
            Err(SttFailure::Closed)
        );
        assert_eq!(
            parse(r#"{"message_type":"input_error"}"#, &mut seq, 0),
            Err(SttFailure::Protocol)
        );
        assert_eq!(parse("not json", &mut seq, 0), Err(SttFailure::Protocol));

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
        let keys: &'static crate::provider_keys::Keys =
            Box::leak(Box::new(crate::provider_keys::Keys::new(
                Box::new(crate::provider_keys::MemoryStore::default()),
                Box::new(Offline),
            )));
        keys.set(crate::provider_keys::Provider::ElevenLabs, FICTIONAL_KEY)
            .unwrap();
        let fake = Fake::default();
        fake.0
            .lock()
            .unwrap()
            .replies
            .push_back(Ok(Some(r#"{"message_type":"auth_error"}"#.into())));
        let mut stream = ElevenLabsStream::start(
            fake,
            RealtimeRequest::for_language(Language::English),
            KeySource::from_keys(keys),
            Duration::from_secs(60),
        );
        let events = wait_for(&mut stream, |e| {
            e.contains(&SttEvent::Failed(SttFailure::Auth))
        });
        assert!(events.contains(&SttEvent::Failed(SttFailure::Auth)));
        assert_eq!(
            keys.status().elevenlabs.state,
            crate::provider_keys::KeyState::Rejected
        );
    }

    #[test]
    fn a_removed_key_opens_no_stream_and_replacement_streams_share_budget() {
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
        let keys: &'static crate::provider_keys::Keys =
            Box::leak(Box::new(crate::provider_keys::Keys::new(
                Box::new(crate::provider_keys::MemoryStore::default()),
                Box::new(Offline),
            )));
        let fake = Fake::default();
        let mut stream = ElevenLabsStream::start(
            fake.clone(),
            RealtimeRequest::for_language(Language::English),
            KeySource::from_keys(keys),
            Duration::from_secs(60),
        );
        let events = wait_for(&mut stream, |e| !e.is_empty());
        assert_eq!(events, vec![SttEvent::Failed(SttFailure::KeyUnavailable)]);
        assert!(fake.0.lock().unwrap().url.is_none());

        let fake2 = Fake::default();
        fake2.0.lock().unwrap().close_on_commit = true;
        let (opener, mut reopener) = key_streams_with(
            fake2.clone(),
            || KeySource::from(FICTIONAL_KEY.to_string()),
            Budget::new(Duration::from_secs(1)),
            Language::Multilingual,
        );
        let mut first = opener().unwrap();
        first.push(&[0.1; SAMPLE_RATE]).unwrap();
        let _ = first.finish(Duration::from_secs(2));
        let sent_first = fake2.0.lock().unwrap().text.len();
        assert!(sent_first >= 10);

        let mut second = reopener().unwrap();
        second.push(&[0.1; FRAME]).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        while !events.contains(&SttEvent::Failed(SttFailure::CapReached)) {
            assert!(Instant::now() < until, "never reached cap: {events:?}");
            events.extend(second.poll());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(events.contains(&SttEvent::Failed(SttFailure::CapReached)));
    }

    #[test]
    fn stalled_stream_probes_with_commit_then_fails_as_stalled() {
        let fake = Fake::default();
        let mut stream = ElevenLabsStream::start_with(
            fake.clone(),
            RealtimeRequest::for_language(Language::English),
            FICTIONAL_KEY.to_string(),
            Duration::from_secs(60),
            Timing {
                quiet_probe: Duration::from_millis(80),
                stall_after: Duration::from_millis(200),
                slow_write: Duration::from_millis(60),
                ..Timing::default()
            },
        );
        let until = Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        while !events.contains(&SttEvent::Failed(SttFailure::Stalled)) {
            assert!(Instant::now() < until, "never stalled: {events:?}");
            let _ = stream.push(&[0.1; FRAME]);
            events.extend(stream.poll());
            std::thread::sleep(Duration::from_millis(10));
        }
        let wire = fake.0.lock().unwrap();
        assert!(wire.text.iter().any(|t| t.contains(r#""commit":true"#)));
        assert!(wire.closed);
    }
}
