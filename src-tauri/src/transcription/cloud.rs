//! Cloud streaming transcription, beside the chunked recognizer path.
//!
//! A `StreamingTranscriber` receives 16 kHz mono audio as it is captured and
//! returns partial and final results. Only finals become engine segments.
//! A provider's speaker label is kept as an untrusted field for the timing
//! log only: it is never shown and never sent to a cue model.
//!
//! Nothing is sent before the session's processing review is approved: until
//! then `CloudFeed` discards audio. The credential is the person's own
//! Deepgram API key from the Keychain (`provider_keys`). A debug build with
//! the `cloud-transcription` feature can instead be pointed at a short-lived
//! token in an owner-only file by `TALKQTE_DEV_STT_BACKEND`, as the lab does;
//! that selection wins over a stored key and is never read in a release.

use super::SAMPLE_RATE;
use crate::engine::Segment;
use crate::engine::SessionSources;
use std::time::Duration;

/// The default provider, as the app names it.
pub const PROVIDER: &str = "Deepgram";

/// Which cloud transcription provider a session with the person's own key uses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Deepgram,
    ElevenLabs,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Deepgram => "Deepgram",
            Self::ElevenLabs => "ElevenLabs",
        }
    }

    pub fn key_provider(self) -> crate::provider_keys::Provider {
        match self {
            Self::Deepgram => crate::provider_keys::Provider::Deepgram,
            Self::ElevenLabs => crate::provider_keys::Provider::ElevenLabs,
        }
    }

    pub fn destination(self) -> &'static str {
        match self {
            Self::Deepgram => "Deepgram (US), for transcription of the session's audio",
            Self::ElevenLabs => "ElevenLabs, for transcription of the session's audio",
        }
    }
}

/// The person's choice for the next live session with their own key, saved
/// in the settings file; Deepgram until changed.
static PROVIDER_CHOICE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// The provider the next session started with the person's key will use.
pub fn provider() -> Provider {
    match PROVIDER_CHOICE.load(std::sync::atomic::Ordering::Acquire) {
        1 => Provider::ElevenLabs,
        _ => Provider::Deepgram,
    }
}

/// Sets the transcription provider for the next session.
pub fn set_provider(provider: Provider) {
    let value = match provider {
        Provider::Deepgram => 0,
        Provider::ElevenLabs => 1,
    };
    PROVIDER_CHOICE.store(value, std::sync::atomic::Ordering::Release);
}

/// The active provider for this launch: development launches always use
/// Deepgram; ordinary launches use the person's saved choice.
pub fn active_provider() -> Provider {
    if dev_selected() {
        Provider::Deepgram
    } else {
        provider()
    }
}

/// The active provider name for snapshots and disclosures.
pub fn active_provider_name() -> &'static str {
    active_provider().name()
}

/// Fixed failure codes. No provider message ever reaches a log or the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SttFailure {
    /// The provider refused the credential (401 or 403).
    Auth,
    /// The account cannot pay for more audio (402).
    Quota,
    /// The provider is limiting requests (429).
    RateLimited,
    /// The per-run minute cap was reached.
    CapReached,
    /// The connection could not be made or was lost.
    Network,
    /// The provider answered the handshake with a server error (5xx): an
    /// outage on its side, not the person's connection.
    Unavailable,
    /// The person's key could not be read from the Keychain when a stream
    /// opened, or it was removed during the session.
    KeyUnavailable,
    /// A reply did not follow the provider's protocol.
    Protocol,
    /// The provider closed the stream.
    Closed,
    /// The development settings or the token file are not usable.
    Settings,
    /// The session's review was turned off after audio began to be sent.
    Withdrawn,
    /// The lab's cue run ended (for example on Pause), which ends the
    /// session's approval in the lab.
    LabEnded,
    /// The connection stopped keeping up: nothing came back while audio was
    /// going out, writes took too long, or audio kept being dropped.
    Stalled,
}

impl SttFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Quota => "quota",
            Self::RateLimited => "rate_limited",
            Self::CapReached => "cap_reached",
            Self::Network => "network",
            Self::Unavailable => "unavailable",
            Self::KeyUnavailable => "key_unavailable",
            Self::Protocol => "protocol",
            Self::Closed => "closed",
            Self::Settings => "settings",
            Self::Withdrawn => "withdrawn",
            Self::LabEnded => "lab_ended",
            Self::Stalled => "stalled",
        }
    }
}

/// What a stream returns. Times are milliseconds of audio since the first
/// sample pushed into this stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SttEvent {
    Partial,
    Final {
        seq: u64,
        text: String,
        start_ms: u64,
        end_ms: u64,
        /// The provider's guess at who spoke. Untrusted: logged only.
        untrusted_speaker: Option<u32>,
    },
    /// The connection is open. `query` is the query string of the URL it
    /// used, without the token.
    Connected {
        query: String,
    },
    Failed(SttFailure),
}

/// The bounded send queue is full; these samples were dropped.
#[derive(Debug, PartialEq, Eq)]
pub struct Full;

/// One provider's live stream. Implementations do their network I/O on their
/// own thread; every method here returns without waiting on the network,
/// except `finish`, which waits at most `wait`.
pub trait StreamingTranscriber: Send {
    /// Queues 16 kHz mono samples for sending.
    fn push(&mut self, samples: &[f32]) -> Result<(), Full>;
    /// Events received since the last call, in order.
    fn poll(&mut self) -> Vec<SttEvent>;
    /// Sends what is queued, closes the stream and returns its last events.
    fn finish(&mut self, wait: Duration) -> Vec<SttEvent>;
    /// Closes at once; nothing more is delivered.
    fn abort(&mut self);
}

/// Opens a stream once the session's review is approved.
pub type Opener = Box<dyn FnOnce() -> Result<Box<dyn StreamingTranscriber>, SttFailure> + Send>;
/// Opens a replacement stream after a connection failure; see
/// `CloudFeed::reconnect_with`.
pub type Reopener = Box<dyn FnMut() -> Result<Box<dyn StreamingTranscriber>, SttFailure> + Send>;

/// Reconnects allowed per stream of a session. Keeps a failing network from
/// opening streams without end while tolerating transient drops in 1-3 hour calls.
pub const MAX_RECONNECTS: u32 = 10;

/// Maps stream audio time back to the session clock, block by block, so a
/// final is timed by when its words were captured.
#[derive(Default)]
pub(crate) struct StreamClock {
    /// (first stream sample, samples, session start ms, session end ms)
    spans: std::collections::VecDeque<(u64, u64, u64, u64)>,
    next: u64,
}

/// Spans kept for mapping: far more than a final can reach back.
const CLOCK_SPANS: usize = 16_384;

impl StreamClock {
    pub(crate) fn record(&mut self, start_ms: u64, end_ms: u64, samples: u64) {
        if samples == 0 {
            return;
        }
        if self.spans.len() == CLOCK_SPANS {
            self.spans.pop_front();
        }
        self.spans
            .push_back((self.next, samples, start_ms, end_ms.max(start_ms)));
        self.next += samples;
    }

    /// Session time of a point in stream audio, or None when it falls
    /// outside the audio pushed so far.
    pub(crate) fn session_ms(&self, stream_ms: u64) -> Option<u64> {
        let sample = stream_ms.checked_mul((SAMPLE_RATE / 1_000) as u64)?;
        let index = self
            .spans
            .partition_point(|(first, samples, _, _)| first + samples <= sample);
        let &(first, samples, start, end) = self.spans.get(index)?;
        if sample < first {
            return None;
        }
        Some(start + (end - start) * (sample - first) / samples)
    }
}

/// Counts for the session report. Contains no audio or text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CloudStats {
    pub sent_ms: u64,
    pub finals: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub dropped_samples: u64,
}

type Sink = Box<dyn FnMut(u64, Segment) -> Result<(), String> + Send>;

/// Audio dropped for a full send queue within this window...
const DROP_WINDOW_MS: u64 = 5_000;
/// ...that ends the stream as `stalled`.
const DROP_LIMIT_MS: u64 = 1_000;

/// Feeds one capture source's audio to one stream and its finals to the
/// engine. Before approval nothing is sent: audio is discarded, not queued.
pub struct CloudFeed {
    session: u64,
    stream_index: u64,
    approved: Box<dyn FnMut() -> Option<u64> + Send>,
    /// The session time of the approval the stream opened under. Audio
    /// captured before it is never sent.
    approved_at: u64,
    opener: Option<Opener>,
    stream: Option<Box<dyn StreamingTranscriber>>,
    clock: StreamClock,
    sink: Sink,
    last_at: u64,
    failure: Option<SttFailure>,
    on_failure: Option<Box<dyn FnMut(SttFailure) + Send>>,
    on_dropped: Option<Box<dyn FnMut() + Send>>,
    keep: Option<Box<dyn FnMut() -> Option<SttFailure> + Send>>,
    /// Audio dropped for a full queue within the current window of
    /// `DROP_WINDOW_MS`: (window start on the session clock, ms dropped).
    drops: (u64, u64),
    reopener: Option<Reopener>,
    on_reconnect: Option<Box<dyn FnMut(u64) + Send>>,
    reconnects: u32,
    /// Lost speech across attempts awaiting a confirmed replacement connection.
    pending_reconnect_gap: Option<u64>,
    /// Line numbers continue across reconnects: a new stream counts from 1
    /// again, so its numbers are offset by the last one seen.
    seq_base: u64,
    last_seq: u64,
    /// Session time of the end of the last line delivered, and of the last
    /// audio pushed: what lies between them when a stream fails is lost.
    last_line_end: u64,
    last_pushed: u64,
    pub stats: CloudStats,
}

impl CloudFeed {
    pub fn new(
        session: u64,
        stream_index: u64,
        opener: Opener,
        approved: impl FnMut() -> Option<u64> + Send + 'static,
        sink: impl FnMut(u64, Segment) -> Result<(), String> + Send + 'static,
    ) -> Self {
        Self {
            session,
            stream_index,
            approved: Box::new(approved),
            approved_at: 0,
            opener: Some(opener),
            stream: None,
            clock: StreamClock::default(),
            sink: Box::new(sink),
            last_at: 0,
            failure: None,
            on_failure: None,
            on_dropped: None,
            keep: None,
            drops: (0, 0),
            reopener: None,
            on_reconnect: None,
            reconnects: 0,
            pending_reconnect_gap: None,
            seq_base: 0,
            last_seq: 0,
            last_line_end: 0,
            last_pushed: 0,
            stats: CloudStats::default(),
        }
    }

    /// Called once, from the feeding thread, when the stream ends with a
    /// failure, so the session can stop and say why.
    pub fn on_failure(mut self, notify: impl FnMut(SttFailure) + Send + 'static) -> Self {
        self.on_failure = Some(Box::new(notify));
        self
    }

    /// After a connection failure (lost, closed, stalled or unreadable),
    /// opens a replacement stream under the same approval, session and
    /// launch budget, up to `MAX_RECONNECTS` times. Audio that was in flight
    /// on the failed stream is lost, not replayed; `on_reconnect` is told
    /// how much session time that spans.
    pub fn reconnect_with(mut self, reopener: Reopener) -> Self {
        self.reopener = Some(reopener);
        self
    }

    /// `reconnect_with`, when a reopener is available.
    pub fn with_reopener(self, reopener: Option<Reopener>) -> Self {
        match reopener {
            Some(reopener) => self.reconnect_with(reopener),
            None => self,
        }
    }

    /// Called from the feeding thread after a replacement confirms Connected, with the
    /// session time (ms) whose speech was lost in the failed stream.
    pub fn on_reconnect(mut self, notify: impl FnMut(u64) + Send + 'static) -> Self {
        self.on_reconnect = Some(Box::new(notify));
        self
    }

    /// Called once, from the feeding thread, the first time audio is
    /// dropped because the send queue is full, so the session can say so.
    pub fn on_dropped(mut self, notify: impl FnMut() + Send + 'static) -> Self {
        self.on_dropped = Some(Box::new(notify));
        self
    }

    /// Once the stream is open, it keeps sending until `stop` names a
    /// reason, instead of while the opening approval holds: a Stop in
    /// progress closes the review but still sends the last captured audio.
    pub fn stop_sending_when(
        mut self,
        keep: impl FnMut() -> Option<SttFailure> + Send + 'static,
    ) -> Self {
        self.keep = Some(Box::new(keep));
        self
    }

    /// The failure that ended this feed, if any.
    pub fn failure(&self) -> Option<SttFailure> {
        self.failure
    }

    /// Audio captured from `start_ms` to `end_ms` on the session clock.
    /// Nothing captured before the approval is sent, whenever it arrives.
    pub fn push(&mut self, start_ms: u64, end_ms: u64, samples: &[f32]) -> Result<(), SttFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        // Turning the review off stops sending at once; the stream is not
        // reopened for this session.
        if self.stream.is_some() {
            if let Some(reason) = self.stop_reason() {
                return Err(self.fail(reason));
            }
        }
        if self.stream.is_none() {
            let Some(approved_at) = (self.approved)() else {
                return Ok(());
            };
            let Some(opener) = self.opener.take() else {
                return Err(self.fail(SttFailure::Closed));
            };
            match opener() {
                Ok(stream) => {
                    crate::timing_log::record(crate::timing_log::Event::SttState {
                        session: self.session,
                        state: "started",
                        code: None,
                        audio_ms: 0,
                        query: None,
                        gap_ms: None,
                    });
                    self.approved_at = approved_at;
                    self.last_line_end = approved_at;
                    self.stream = Some(stream);
                }
                Err(failure) => return Err(self.fail(failure)),
            }
        }
        // Audio captured before the approval: drop it, or its leading part.
        let (start_ms, samples) = if end_ms <= self.approved_at {
            return self.poll();
        } else if start_ms < self.approved_at {
            let skip =
                ((self.approved_at - start_ms) as usize * SAMPLE_RATE / 1_000).min(samples.len());
            (self.approved_at, &samples[skip..])
        } else {
            (start_ms, samples)
        };
        if samples.is_empty() {
            return self.poll();
        }
        let stream = self.stream.as_mut().expect("stream opened");
        match stream.push(samples) {
            Ok(()) => {
                self.last_pushed = self.last_pushed.max(end_ms);
                self.clock.record(start_ms, end_ms, samples.len() as u64);
                self.stats.sent_ms += samples.len() as u64 * 1_000 / SAMPLE_RATE as u64;
            }
            Err(Full) => {
                if self.stats.dropped_samples == 0 {
                    crate::timing_log::record(crate::timing_log::Event::SttState {
                        session: self.session,
                        state: "dropping",
                        code: None,
                        audio_ms: self.stats.sent_ms,
                        query: None,
                        gap_ms: None,
                    });
                    if let Some(notify) = self.on_dropped.as_mut() {
                        notify();
                    }
                }
                self.stats.dropped_samples += samples.len() as u64;
                // A stream that keeps refusing audio is not keeping up: end
                // it, rather than drop the rest of the meeting silently.
                if start_ms.saturating_sub(self.drops.0) > DROP_WINDOW_MS {
                    self.drops = (start_ms, 0);
                }
                self.drops.1 += end_ms.saturating_sub(start_ms);
                if self.drops.1 >= DROP_LIMIT_MS {
                    self.drops = (start_ms, 0);
                    return self.fail_or_reconnect(SttFailure::Stalled);
                }
            }
        }
        self.poll()
    }

    /// Delivers finals received so far.
    pub fn poll(&mut self) -> Result<(), SttFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        let events = match self.stream.as_mut() {
            Some(stream) => stream.poll(),
            None => return Ok(()),
        };
        self.deliver(events)
    }

    /// Sends what is queued, closes the stream and delivers its last finals.
    pub fn finish(mut self, wait: Duration) -> CloudStats {
        // Stop sends what is left on this connection; it never opens another.
        self.reopener = None;
        self.pending_reconnect_gap = None;
        if self.failure.is_none() {
            if let Some(mut stream) = self.stream.take() {
                let events = stream.finish(wait);
                let _ = self.deliver(events);
                self.stopped("finished");
            }
        }
        self.stats
    }

    /// Closes at once for End: nothing more reaches the engine.
    pub fn end(mut self) -> CloudStats {
        self.reopener = None;
        if let Some(mut stream) = self.stream.take() {
            stream.abort();
            self.stopped("ended");
        }
        self.stats
    }

    fn deliver(&mut self, events: Vec<SttEvent>) -> Result<(), SttFailure> {
        for event in events {
            match event {
                SttEvent::Partial => {}
                SttEvent::Connected { query } => {
                    if let Some(gap_ms) = self.pending_reconnect_gap.take() {
                        // Starting the worker is not a successful connection. Also
                        // refuse a late confirmation after its approval was retired.
                        if let Some(reason) = self.stop_reason() {
                            return Err(self.fail(reason));
                        }
                        if (self.approved)() != Some(self.approved_at) {
                            return Err(self.fail(SttFailure::Withdrawn));
                        }
                        if let Some(notify) = self.on_reconnect.as_mut() {
                            notify(gap_ms);
                        }
                    }
                    crate::timing_log::record(crate::timing_log::Event::SttState {
                        session: self.session,
                        state: "connected",
                        code: None,
                        audio_ms: self.stats.sent_ms,
                        query: Some(query),
                        gap_ms: None,
                    });
                }
                SttEvent::Final {
                    seq,
                    text,
                    start_ms,
                    end_ms,
                    untrusted_speaker,
                } => {
                    let seq = self.seq_base + seq;
                    self.last_seq = self.last_seq.max(seq);
                    self.stats.finals += 1;
                    let (Some(at), Some(end)) = (
                        self.clock.session_ms(start_ms),
                        self.clock
                            .session_ms(end_ms)
                            .or(self.clock.session_ms(start_ms)),
                    ) else {
                        self.stats.rejected += 1;
                        continue;
                    };
                    // Lines reach the engine in order, never earlier than the last.
                    let at = at.max(self.last_at);
                    self.last_at = at;
                    self.last_line_end = self.last_line_end.max(end.max(at));
                    crate::timing_log::record(crate::timing_log::Event::SttFinal {
                        session: self.session,
                        seq,
                        start_ms: at,
                        end_ms: end.max(at),
                        untrusted_speaker,
                    });
                    let segment = Segment {
                        id: format!("c{}-{}-{}", self.session, self.stream_index, seq),
                        at_ms: at,
                        speaker: "Speaker".into(),
                        text,
                    };
                    match (self.sink)(self.session, segment) {
                        Ok(()) => self.stats.accepted += 1,
                        Err(_) => self.stats.rejected += 1,
                    }
                }
                SttEvent::Failed(failure) => return self.fail_or_reconnect(failure),
            }
        }
        Ok(())
    }

    /// A failure the network may cause opens a replacement stream when one
    /// is allowed; anything else, or one reconnect too many, ends the feed.
    fn fail_or_reconnect(&mut self, failure: SttFailure) -> Result<(), SttFailure> {
        let recoverable = matches!(
            failure,
            SttFailure::Network
                | SttFailure::Unavailable
                | SttFailure::Closed
                | SttFailure::Stalled
                | SttFailure::Protocol
        );
        if !recoverable || self.reconnects >= MAX_RECONNECTS || self.reopener.is_none() {
            return Err(self.fail(failure));
        }
        // Never open a new connection once the review that allowed the old
        // one is withdrawn, replaced, or the session is ending: stop with
        // that reason instead.
        if let Some(reason) = self.stop_reason() {
            return Err(self.fail(reason));
        }
        if (self.approved)() != Some(self.approved_at) {
            return Err(self.fail(SttFailure::Withdrawn));
        }
        if let Some(mut stream) = self.stream.take() {
            stream.abort();
        }
        self.reconnects += 1;
        // Speech after the last line the failed stream delivered, up to the
        // last audio it was given, is lost with it.
        let gap_ms = self.last_pushed.saturating_sub(self.last_line_end);
        crate::timing_log::record(crate::timing_log::Event::SttState {
            session: self.session,
            state: "reconnecting",
            code: Some(failure.code()),
            audio_ms: self.stats.sent_ms,
            query: None,
            gap_ms: Some(gap_ms),
        });
        let reopen = self.reopener.as_mut().expect("checked above");
        match reopen() {
            Ok(stream) => {
                self.stream = Some(stream);
                self.clock = StreamClock::default();
                self.seq_base = self.last_seq;
                self.last_line_end = self.last_pushed;
                self.pending_reconnect_gap = Some(
                    self.pending_reconnect_gap
                        .unwrap_or(0)
                        .saturating_add(gap_ms),
                );
                Ok(())
            }
            Err(again) => Err(self.fail(again)),
        }
    }

    fn stop_reason(&mut self) -> Option<SttFailure> {
        // A different approval than the one the stream opened under means the
        // review was withdrawn and given again between two pushes: the old
        // stream is not kept open under the new approval.
        let approval = (self.approved)();
        if approval.is_some_and(|at| at != self.approved_at) {
            return Some(SttFailure::Withdrawn);
        }
        match self.keep.as_mut() {
            Some(keep) => keep(),
            None => approval.is_none().then_some(SttFailure::Withdrawn),
        }
    }

    fn fail(&mut self, failure: SttFailure) -> SttFailure {
        self.failure = Some(failure);
        if let Some(mut stream) = self.stream.take() {
            stream.abort();
        }
        crate::timing_log::record(crate::timing_log::Event::SttState {
            session: self.session,
            state: "stopped",
            code: Some(failure.code()),
            audio_ms: self.stats.sent_ms,
            query: None,
            gap_ms: None,
        });
        if let Some(mut notify) = self.on_failure.take() {
            notify(failure);
        }
        failure
    }

    fn stopped(&mut self, state: &'static str) {
        crate::timing_log::record(crate::timing_log::Event::SttState {
            session: self.session,
            state,
            code: None,
            audio_ms: self.stats.sent_ms,
            query: None,
            gap_ms: None,
        });
    }
}

/// The language Deepgram is asked to transcribe. Deepgram cannot detect a
/// language on a live stream, so it is chosen before a session starts and a
/// session's streams, reconnects included, keep the one they began with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Language {
    /// `language=en`, the request since #344.
    #[default]
    #[serde(rename = "en")]
    English,
    /// `language=multi`: several languages, following switches within one
    /// stream. Deepgram bills it at a higher rate than English.
    #[serde(rename = "multi")]
    Multilingual,
}

impl Language {
    /// How the review names it.
    fn review_label(self, provider: Provider) -> &'static str {
        match (provider, self) {
            (Provider::Deepgram, Self::English) => "English",
            (Provider::Deepgram, Self::Multilingual) => {
                "Multilingual, which Deepgram bills at a higher rate than English"
            }
            (Provider::ElevenLabs, Self::English) => "English",
            (Provider::ElevenLabs, Self::Multilingual) => {
                "Multilingual (automatic language detection)"
            }
        }
    }
}

/// The person's choice for the next live session with their own key, saved
/// in the settings file; English until changed.
static LANGUAGE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The language the next session started with the person's key will use.
pub fn language() -> Language {
    if LANGUAGE.load(std::sync::atomic::Ordering::Acquire) {
        Language::Multilingual
    } else {
        Language::English
    }
}

/// Sets the language for the next session. A session already running keeps
/// the language it started with: its streams were made at its start.
pub fn set_language(language: Language) {
    LANGUAGE.store(
        language == Language::Multilingual,
        std::sync::atomic::Ordering::Release,
    );
}

/// Development settings for cloud transcription.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub token_file: std::path::PathBuf,
    pub minute_cap: u32,
    /// `TALKQTE_DEV_STT_LANGUAGE`: absent or `en` for English, `multi` for
    /// multilingual. A lab plan asks for multilingual explicitly.
    pub language: Language,
}

impl Settings {
    /// `TALKQTE_DEV_STT_BACKEND=deepgram`, an absolute
    /// `TALKQTE_DEV_STT_TOKEN_FILE`, and `TALKQTE_DEV_STT_MINUTE_CAP` from 1
    /// to 60. Anything else is refused; nothing falls back to another path.
    pub fn parse(mut get: impl FnMut(&str) -> Option<String>) -> Result<Self, SttFailure> {
        if get("TALKQTE_DEV_STT_BACKEND").as_deref() != Some("deepgram") {
            return Err(SttFailure::Settings);
        }
        let token_file = std::path::PathBuf::from(
            get("TALKQTE_DEV_STT_TOKEN_FILE").ok_or(SttFailure::Settings)?,
        );
        let cap = get("TALKQTE_DEV_STT_MINUTE_CAP").ok_or(SttFailure::Settings)?;
        if !token_file.is_absolute()
            || cap.is_empty()
            || cap.len() > 2
            || cap.starts_with('0')
            || !cap.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(SttFailure::Settings);
        }
        let minute_cap: u32 = cap.parse().map_err(|_| SttFailure::Settings)?;
        if !(1..=60).contains(&minute_cap) {
            return Err(SttFailure::Settings);
        }
        let language = match get("TALKQTE_DEV_STT_LANGUAGE").as_deref() {
            None | Some("en") => Language::English,
            Some("multi") => Language::Multilingual,
            Some(_) => return Err(SttFailure::Settings),
        };
        Ok(Self {
            token_file,
            minute_cap,
            language,
        })
    }

    pub fn cap(&self) -> Duration {
        Duration::from_secs(u64::from(self.minute_cap) * 60)
    }
}

/// Whether this launch asked for development cloud transcription. Only a
/// debug build with the `cloud-transcription` feature reads the setting; a
/// release build never selects it.
pub fn dev_selected() -> bool {
    cfg!(all(debug_assertions, feature = "cloud-transcription"))
        && std::env::var_os("TALKQTE_DEV_STT_BACKEND").is_some()
}

/// Whether live sessions transcribe through cloud STT: the development
/// selection, or else a stored key for the chosen provider. Without either,
/// nothing is transcribed.
pub fn selected() -> bool {
    dev_selected() || crate::provider_keys::global().is_set(provider().key_provider())
}

/// Where this launch's transcription credential comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// The development token file and launch-wide minute cap.
    Dev(Settings),
    /// The person's own key, read from the Keychain when a stream opens,
    /// with a cap of [`OWN_KEY_MINUTE_CAP`] minutes per session.
    OwnKey(Provider),
}

/// Most minutes of audio one live session may send with the person's own
/// key, across that session's reconnects. Sized at 480 minutes (8 hours
/// single-stream / 4 hours with both microphone and system audio) so 1-3 hour
/// meetings never hit the cap prematurely. A development application source
/// started into a session opens its own streams under a separate budget of
/// the same size.
pub const OWN_KEY_MINUTE_CAP: u32 = 480;

/// The launch's source: development settings when selected (and then only
/// they, even if invalid), otherwise a stored key for the chosen provider.
pub fn source() -> Result<Source, ReadinessFailure> {
    let chosen = provider();
    source_for(
        dev_selected().then(settings),
        chosen,
        crate::provider_keys::global()
            .status()
            .of(chosen.key_provider())
            .state,
    )
}

fn source_for(
    dev: Option<Result<Settings, SttFailure>>,
    provider: Provider,
    key: crate::provider_keys::KeyState,
) -> Result<Source, ReadinessFailure> {
    use crate::provider_keys::KeyState;
    match (dev, key) {
        (Some(settings), _) => settings
            .map(Source::Dev)
            .map_err(|_| ReadinessFailure::Settings),
        (None, KeyState::Set) => Ok(Source::OwnKey(provider)),
        (None, KeyState::Rejected) => Err(ReadinessFailure::KeyRejected),
        (None, KeyState::NotSet) => Err(ReadinessFailure::NoKey),
        (None, KeyState::Unreadable) => Err(ReadinessFailure::KeyUnreadable),
    }
}

/// The launch's development settings, read once.
pub fn settings() -> Result<Settings, SttFailure> {
    static SETTINGS: std::sync::OnceLock<Result<Settings, SttFailure>> = std::sync::OnceLock::new();
    SETTINGS
        .get_or_init(|| {
            if !dev_selected() {
                return Err(SttFailure::Settings);
            }
            Settings::parse(|key| std::env::var(key).ok())
        })
        .clone()
}

/// The stream failure for an engine's reason to stop sending audio.
pub fn withdrawal(reason: Option<&'static str>) -> Option<SttFailure> {
    reason.map(|reason| match reason {
        "lab_ended" => SttFailure::LabEnded,
        _ => SttFailure::Withdrawn,
    })
}

/// The audio a launch may still send, shared by every stream of the launch,
/// microphone and application audio alike, across sessions.
#[derive(Clone, Debug)]
pub struct Budget(std::sync::Arc<std::sync::atomic::AtomicU64>);

impl Budget {
    pub fn new(cap: Duration) -> Self {
        Self(std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
            cap.as_secs() * SAMPLE_RATE as u64,
        )))
    }

    /// How much audio is still allowed.
    pub fn left(&self) -> Duration {
        let samples = self.0.load(std::sync::atomic::Ordering::Acquire);
        Duration::from_millis(samples * 1000 / SAMPLE_RATE as u64)
    }

    /// Takes up to `want` samples from what is left; returns how many.
    pub fn reserve(&self, want: u64) -> u64 {
        use std::sync::atomic::Ordering;
        let mut granted = 0;
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                granted = left.min(want);
                Some(left - granted)
            });
        granted
    }
}

impl From<Duration> for Budget {
    fn from(cap: Duration) -> Self {
        Self::new(cap)
    }
}

/// This launch's budget, made once from its minute cap.
pub fn launch_budget(settings: &Settings) -> Budget {
    static BUDGET: std::sync::OnceLock<Budget> = std::sync::OnceLock::new();
    BUDGET.get_or_init(|| Budget::new(settings.cap())).clone()
}

/// Whether this launch can transcribe: a stored key that the provider has
/// not rejected, or development settings that parse with a token file that
/// passes the owner-only checks. Neither credential is read until a stream
/// opens, so a bad setup is reported before anyone is asked to approve
/// anything.
pub fn ready() -> Result<(), SttFailure> {
    readiness().map_err(|_| SttFailure::Settings)
}

/// Fixed readiness classification; never contains a path, credential or OS error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadinessFailure {
    Settings,
    TokenMetadata,
    /// No Deepgram key is stored.
    NoKey,
    /// Deepgram refused the stored key, at a check or in a session.
    KeyRejected,
    /// The Keychain could not be read.
    KeyUnreadable,
}

/// The same metadata-only checks as `ready`, with their boundary retained.
/// No token or key content is read and no connection is opened.
pub fn readiness() -> Result<(), ReadinessFailure> {
    match source()? {
        Source::Dev(settings) => readiness_for(Ok(settings)),
        Source::OwnKey(_) => Ok(()),
    }
}

fn readiness_for(settings: Result<Settings, SttFailure>) -> Result<(), ReadinessFailure> {
    let settings = settings.map_err(|_| ReadinessFailure::Settings)?;
    check_token_file(&settings.token_file).map_err(|_| ReadinessFailure::TokenMetadata)
}

/// The streams for one capture source of a session: the opener, used once
/// the review is approved, and the reopener for replacement streams after a
/// connection failure. Both share one minute budget.
pub struct Streams {
    opener: Opener,
    reopener: Option<Reopener>,
    /// The session budget with the person's key; `None` with development
    /// settings, whose launch budget is already shared by every source.
    budget: Option<Budget>,
}

impl Streams {
    pub fn new(opener: Opener, reopener: Option<Reopener>) -> Self {
        Self {
            opener,
            reopener,
            budget: None,
        }
    }

    /// The minute budget these streams spend, to give a session's second
    /// source the same one.
    pub fn budget(&self) -> Option<Budget> {
        self.budget.clone()
    }

    pub fn into_parts(self) -> (Opener, Option<Reopener>) {
        (self.opener, self.reopener)
    }
}

/// The streams for a capture source, made once per live start after the
/// start gate is taken. They read the token file or the stored key only when
/// a stream opens, after the review is approved. Refused when neither is
/// usable; there is never a fallback to another recognizer. With the
/// person's key, a new budget of [`OWN_KEY_MINUTE_CAP`] minutes is made here
/// and shared by this opener and its reopener only, so no other start can
/// replace or reuse it; with development settings the launch budget is used.
pub fn streams() -> Result<Streams, SttFailure> {
    Ok(streams_for(
        source().map_err(|_| SttFailure::Settings)?,
        None,
    ))
}

/// Streams for a session's second capture source, spending `budget`, the
/// budget its first source's [`streams`] made, so the session has one cap
/// across both. With development settings the launch budget is used, as for
/// every source. With the person's key and no session budget the source is
/// refused: it never gets a fresh cap of its own. Refused when neither is
/// usable, like [`streams`].
pub fn streams_sharing(budget: Option<Budget>) -> Result<Streams, SttFailure> {
    joining_streams(source().map_err(|_| SttFailure::Settings)?, budget)
}

fn joining_streams(source: Source, budget: Option<Budget>) -> Result<Streams, SttFailure> {
    if matches!(source, Source::OwnKey(_)) && budget.is_none() {
        return Err(SttFailure::Settings);
    }
    Ok(streams_for(source, budget))
}

/// The language a source's streams use: the launch setting for a
/// development source, the person's setting otherwise.
fn language_of(source: &Source) -> Language {
    match source {
        Source::Dev(settings) => settings.language,
        Source::OwnKey(_) => language(),
    }
}

fn streams_for(source: Source, shared: Option<Budget>) -> Streams {
    let language = language_of(&source);
    match source {
        Source::Dev(settings) => Streams::new(
            super::deepgram::opener(settings.clone()),
            Some(super::deepgram::reopener(settings)),
        ),
        Source::OwnKey(_) => {
            let budget = shared.unwrap_or_else(|| {
                Budget::new(Duration::from_secs(u64::from(OWN_KEY_MINUTE_CAP) * 60))
            });
            let (opener, reopener) = match source {
                Source::OwnKey(Provider::Deepgram) => {
                    super::deepgram::key_streams(budget.clone(), language)
                }
                Source::OwnKey(Provider::ElevenLabs) => {
                    super::elevenlabs::key_streams(budget.clone(), language)
                }
                Source::Dev(_) => unreachable!(),
            };
            Streams {
                budget: Some(budget),
                ..Streams::new(opener, Some(reopener))
            }
        }
    }
}

/// The sentence the session review adds when cloud transcription is
/// selected, so one approval covers both exports. It names exactly the
/// session's capture sources.
pub fn review_sentence(sources: &SessionSources) -> Option<String> {
    review_sentence_for(&source().ok()?, sources)
}

/// The review sentence with the person's own key, for checks of a whole
/// review's text.
#[cfg(test)]
pub(crate) fn review_sentence_for_own_key(language: Language, sources: &SessionSources) -> String {
    review_sentence_for_own_key_provider(Provider::Deepgram, language, sources)
}

#[cfg(test)]
pub(crate) fn review_sentence_for_own_key_provider(
    provider: Provider,
    language: Language,
    sources: &SessionSources,
) -> String {
    review_sentence_with(&Source::OwnKey(provider), language, sources).expect("always worded")
}

fn review_sentence_for(source: &Source, sources: &SessionSources) -> Option<String> {
    review_sentence_with(source, language_of(source), sources)
}

/// What the session's audio is, in the review's words.
fn audio_of(sources: &SessionSources) -> String {
    match (sources.microphone, sources.application.as_deref()) {
        (true, None) => "the live audio from your microphone".into(),
        (false, Some(app)) => format!(
            "the live audio of {app} (audio from all of its windows may be included), not your microphone,"
        ),
        (true, Some(crate::engine::SYSTEM_AUDIO)) => {
            "the live audio from your microphone and, as a second stream, macOS system audio (all apps except TalkQTE),".into()
        }
        (true, Some(app)) => format!(
            "the live audio from your microphone and, as a second stream, from {app} (audio from all of its windows may be included),"
        ),
        (false, None) => "no audio".into(),
    }
}

fn review_sentence_with(
    source: &Source,
    language: Language,
    sources: &SessionSources,
) -> Option<String> {
    let provider = match source {
        Source::Dev(_) => Provider::Deepgram,
        Source::OwnKey(provider) => *provider,
    };
    let label = language.review_label(provider);
    let audio = audio_of(sources);
    const END: &str =
        "If transcription stops, nothing is transcribed and nothing falls back to another service.";
    let both = sources.both_sources();
    Some(match source {
        Source::Dev(settings) => {
            let sent = format!(
                "Audio: this approval also sends {audio} to Deepgram (US, model Nova-3, {label}) for transcription"
            );
            const TERMS: &str = "Each request asks Deepgram to opt out of its Model Improvement Program; what Deepgram keeps is set by its terms (https://deepgram.com/terms). Audio captured before this approval is never sent.";
            format!(
                "{sent}. {TERMS} At most {} minutes of audio for this whole launch, across sessions and sources. {END}",
                settings.minute_cap
            )
        }
        Source::OwnKey(Provider::Deepgram) => {
            let sent = format!(
                "Audio: this approval also sends {audio} to Deepgram (US, model Nova-3, {label}) for transcription"
            );
            const TERMS: &str = "Each request asks Deepgram to opt out of its Model Improvement Program; what Deepgram keeps is set by its terms (https://deepgram.com/terms). Audio captured before this approval is never sent.";
            let across = if both {
                ", counted across both streams, so two at once use it twice as fast"
            } else {
                ""
            };
            format!(
                "{sent}, with your own Deepgram API key: Deepgram bills your account for each minute of audio{}. {TERMS} At most {OWN_KEY_MINUTE_CAP} minutes of audio for this session{across}. Pausing cues does not stop the audio; turning processing off or Stop does{}. {END}",
                if both { " of each stream" } else { "" },
                if both { ", for both" } else { "" },
            )
        }
        Source::OwnKey(Provider::ElevenLabs) => {
            let sent = format!(
                "Audio: this approval also sends {audio} to ElevenLabs (model Scribe v2 Realtime, {label}) for transcription"
            );
            const TERMS: &str = "ElevenLabs handles what is sent under its terms (https://elevenlabs.io/terms). Audio captured before this approval is never sent.";
            let across = if both {
                ", counted across both streams, so two at once use it twice as fast"
            } else {
                ""
            };
            format!(
                "{sent}, with your own ElevenLabs API key: ElevenLabs bills your account for usage. {TERMS} At most {OWN_KEY_MINUTE_CAP} minutes of audio for this session{across}. Pausing cues does not stop the audio; turning processing off or Stop does{}. {END}",
                if both { ", for both" } else { "" },
            )
        }
    })
}

/// The audio destination the session review names beside the cue
/// destination, when cloud transcription is selected.
pub fn audio_destination() -> Option<String> {
    source().ok().map(|s| match s {
        Source::Dev(_) => Provider::Deepgram.destination().to_string(),
        Source::OwnKey(provider) => provider.destination().to_string(),
    })
}

/// Checks the token file without reading the token.
pub fn check_token_file(path: &std::path::Path) -> Result<(), SttFailure> {
    open_token_file(path).map(drop)
}

/// Reads a short-lived token from an owner-only file: a 0600 regular file,
/// not a symlink, at most 4 KiB, owned by this user, in a 0700 directory
/// owned by this user. The token is never logged.
pub fn read_token(path: &std::path::Path) -> Result<String, SttFailure> {
    use std::io::Read;
    let mut file = open_token_file(path)?;
    let mut text = String::new();
    file.by_ref()
        .take(4097)
        .read_to_string(&mut text)
        .map_err(|_| SttFailure::Settings)?;
    let token = text.trim();
    if token.len() < 20
        || token.len() > 4096
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(SttFailure::Settings);
    }
    Ok(token.to_string())
}

/// Opens the token file after the owner-only checks on it and its folder.
/// Other platforms have no such checks and are refused.
#[cfg(not(unix))]
fn open_token_file(_: &std::path::Path) -> Result<std::fs::File, SttFailure> {
    Err(SttFailure::Settings)
}

#[cfg(unix)]
fn open_token_file(path: &std::path::Path) -> Result<std::fs::File, SttFailure> {
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let parent = path.parent().ok_or(SttFailure::Settings)?;
    let dir = fs::symlink_metadata(parent).map_err(|_| SttFailure::Settings)?;
    // SAFETY: geteuid has no arguments or side effects.
    let uid = unsafe { libc::geteuid() };
    if !dir.is_dir() || dir.uid() != uid || dir.mode() & 0o777 != 0o700 {
        return Err(SttFailure::Settings);
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| SttFailure::Settings)?;
    let meta = file.metadata().map_err(|_| SttFailure::Settings)?;
    if !meta.is_file() || meta.uid() != uid || meta.mode() & 0o777 != 0o600 || meta.len() > 4096 {
        return Err(SttFailure::Settings);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};

    /// A scripted stream: records what it is sent and returns queued events.
    #[derive(Clone, Default)]
    struct Script {
        sent: Arc<Mutex<Vec<usize>>>,
        events: Arc<Mutex<Vec<SttEvent>>>,
        aborted: Arc<Mutex<bool>>,
        full: bool,
    }
    impl StreamingTranscriber for Script {
        fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
            if self.full {
                return Err(Full);
            }
            self.sent.lock().unwrap().push(samples.len());
            Ok(())
        }
        fn poll(&mut self) -> Vec<SttEvent> {
            std::mem::take(&mut *self.events.lock().unwrap())
        }
        fn finish(&mut self, _: Duration) -> Vec<SttEvent> {
            self.poll()
        }
        fn abort(&mut self) {
            *self.aborted.lock().unwrap() = true;
        }
    }

    fn final_(seq: u64, start_ms: u64, speaker: Option<u32>) -> SttEvent {
        SttEvent::Final {
            seq,
            text: format!("Fictional line {seq}."),
            start_ms,
            end_ms: start_ms + 500,
            untrusted_speaker: speaker,
        }
    }

    fn feed(script: &Script, approved: Arc<Mutex<bool>>) -> (CloudFeed, mpsc::Receiver<Segment>) {
        let (tx, rx) = mpsc::channel();
        let stream = script.clone();
        let feed = CloudFeed::new(
            7,
            1,
            Box::new(move || Ok(Box::new(stream) as Box<dyn StreamingTranscriber>)),
            move || approved.lock().unwrap().then_some(0),
            move |_, segment| {
                tx.send(segment).unwrap();
                Ok(())
            },
        );
        (feed, rx)
    }

    #[test]
    fn nothing_is_sent_before_approval_and_audio_is_not_held_for_later() {
        let script = Script::default();
        let approved = Arc::new(Mutex::new(false));
        let (mut feed, _) = feed(&script, approved.clone());
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        assert!(script.sent.lock().unwrap().is_empty());
        *approved.lock().unwrap() = true;
        feed.push(100, 200, &[0.1; 1_600]).unwrap();
        // Only audio captured after approval is sent.
        assert_eq!(*script.sent.lock().unwrap(), vec![1_600]);
        assert_eq!(feed.stats.sent_ms, 100);
    }

    #[test]
    fn only_finals_become_segments_on_the_capture_clock_with_no_speaker_label() {
        let script = Script::default();
        let (mut feed, rx) = feed(&script, Arc::new(Mutex::new(true)));
        // Two blocks: stream 0-1 s maps to session 5.0-6.0 s, 1-2 s to 9.0-10.0 s.
        feed.push(5_000, 6_000, &[0.1; 16_000]).unwrap();
        feed.push(9_000, 10_000, &[0.1; 16_000]).unwrap();
        script.events.lock().unwrap().extend([
            SttEvent::Partial,
            final_(1, 250, Some(3)),
            final_(2, 1_500, Some(1)),
        ]);
        feed.poll().unwrap();
        let lines: Vec<Segment> = rx.try_iter().collect();
        assert_eq!(lines.len(), 2, "partials never reach the engine");
        assert_eq!(lines[0].at_ms, 5_250);
        assert_eq!(lines[1].at_ms, 9_500);
        assert_eq!(lines[0].id, "c7-1-1");
        assert!(lines.iter().all(|l| l.speaker == "Speaker"));
        assert_eq!(feed.stats.accepted, 2);
    }

    #[test]
    fn a_failure_stops_the_feed_with_no_fallback_and_later_audio_is_refused() {
        let script = Script::default();
        let (mut feed, rx) = feed(&script, Arc::new(Mutex::new(true)));
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        script
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Network));
        assert_eq!(feed.poll(), Err(SttFailure::Network));
        assert!(*script.aborted.lock().unwrap());
        assert_eq!(feed.push(100, 200, &[0.1; 1_600]), Err(SttFailure::Network));
        assert_eq!(feed.failure(), Some(SttFailure::Network));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn an_approval_withdrawn_and_given_again_between_pushes_closes_the_old_stream() {
        let script = Script::default();
        let approval = Arc::new(Mutex::new(Some(100)));
        let (tx, _rx) = mpsc::channel();
        let stream = script.clone();
        let seen = approval.clone();
        let mut feed = CloudFeed::new(
            7,
            1,
            Box::new(move || Ok(Box::new(stream) as Box<dyn StreamingTranscriber>)),
            move || *seen.lock().unwrap(),
            move |_, segment| {
                tx.send(segment).unwrap();
                Ok(())
            },
        )
        // The engine sees a valid approval both times, so it names no reason.
        .stop_sending_when(|| None);
        feed.push(100, 200, &[0.1; 1_600]).unwrap();
        // Off, then a new review, between two pushes: a different approval.
        *approval.lock().unwrap() = Some(500);
        assert_eq!(
            feed.push(600, 700, &[0.1; 1_600]),
            Err(SttFailure::Withdrawn)
        );
        assert_eq!(*script.sent.lock().unwrap(), vec![1_600]);
        assert!(*script.aborted.lock().unwrap());
    }

    #[test]
    fn turning_the_review_off_closes_the_stream_and_says_so_once() {
        let script = Script::default();
        let approved = Arc::new(Mutex::new(true));
        let told = Arc::new(Mutex::new(vec![]));
        let record = told.clone();
        let mut feed = feed(&script, approved.clone())
            .0
            .on_failure(move |failure| record.lock().unwrap().push(failure));
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        *approved.lock().unwrap() = false;
        assert_eq!(
            feed.push(100, 200, &[0.1; 1_600]),
            Err(SttFailure::Withdrawn)
        );
        // Approval again does not reopen it, and nothing more is sent.
        *approved.lock().unwrap() = true;
        assert_eq!(
            feed.push(200, 300, &[0.1; 1_600]),
            Err(SttFailure::Withdrawn)
        );
        assert_eq!(*script.sent.lock().unwrap(), vec![1_600]);
        assert!(*script.aborted.lock().unwrap());
        assert_eq!(*told.lock().unwrap(), vec![SttFailure::Withdrawn]);
    }

    #[test]
    fn a_stop_in_progress_still_sends_the_last_audio_but_never_opens_a_stream() {
        let script = Script::default();
        let approved = Arc::new(Mutex::new(true));
        let stopping = Arc::new(Mutex::new(false));
        let flag = stopping.clone();
        let mut opened = feed(&script, approved.clone())
            .0
            .stop_sending_when(move || (!*flag.lock().unwrap()).then_some(SttFailure::Withdrawn));
        opened.push(0, 100, &[0.1; 1_600]).unwrap();
        // Stop closes the review; the queued tail is still sent.
        *approved.lock().unwrap() = false;
        *stopping.lock().unwrap() = true;
        opened.push(100, 200, &[0.1; 1_600]).unwrap();
        assert_eq!(*script.sent.lock().unwrap(), vec![1_600, 1_600]);

        // A feed never approved does not open during a Stop.
        let unopened = Script::default();
        let mut never = feed(&unopened, Arc::new(Mutex::new(false)))
            .0
            .stop_sending_when(|| None);
        never.push(0, 100, &[0.1; 1_600]).unwrap();
        assert!(unopened.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn audio_captured_before_the_approval_is_never_sent_however_late_it_arrives() {
        let script = Script::default();
        let (tx, _rx) = mpsc::channel();
        let stream = script.clone();
        // Approved at 1,150 ms on the session clock.
        let mut feed = CloudFeed::new(
            7,
            1,
            Box::new(move || Ok(Box::new(stream) as Box<dyn StreamingTranscriber>)),
            || Some(1_150),
            move |_, segment| {
                tx.send(segment).unwrap();
                Ok(())
            },
        );
        // Captured wholly before the approval but pushed after it: dropped.
        feed.push(1_000, 1_100, &[0.1; 1_600]).unwrap();
        assert!(script.sent.lock().unwrap().is_empty());
        // Straddling it: only the part from 1,150 ms on is sent.
        feed.push(1_100, 1_200, &[0.1; 1_600]).unwrap();
        feed.push(1_200, 1_300, &[0.1; 1_600]).unwrap();
        assert_eq!(*script.sent.lock().unwrap(), vec![800, 1_600]);
        assert_eq!(feed.clock.session_ms(0), Some(1_150));
    }

    #[test]
    fn a_stream_that_keeps_refusing_audio_ends_as_stalled() {
        let script = Script {
            full: true,
            ..Script::default()
        };
        let mut feed = feed(&script, Arc::new(Mutex::new(true))).0;
        // Nine 100 ms blocks refused within the window: still going.
        for n in 0..9 {
            feed.push(n * 100, n * 100 + 100, &[0.1; 1_600]).unwrap();
        }
        // The tenth makes a full second dropped within five: it ends.
        assert_eq!(
            feed.push(900, 1_000, &[0.1; 1_600]),
            Err(SttFailure::Stalled)
        );
        assert_eq!(feed.failure(), Some(SttFailure::Stalled));
        // A drop now and then, spread out, does not end a stream.
        let mut spread = feed_ok_then_full(&script);
        for n in 0..6 {
            let at = n * 6_000;
            spread.push(at, at + 900, &[0.1; 14_400]).unwrap();
        }
        assert_eq!(spread.failure(), None);
    }

    fn feed_ok_then_full(script: &Script) -> CloudFeed {
        feed(script, Arc::new(Mutex::new(true))).0
    }

    /// A feed whose first stream is `first` and whose replacements, in
    /// order, are `next`; it reports each reconnect's lost time.
    fn reconnecting(
        first: &Script,
        next: Vec<Result<Script, SttFailure>>,
    ) -> (CloudFeed, mpsc::Receiver<Segment>, Arc<Mutex<Vec<u64>>>) {
        let (feed, rx) = feed(first, Arc::new(Mutex::new(true)));
        let lost = Arc::new(Mutex::new(Vec::new()));
        let record = lost.clone();
        let mut next = next.into_iter();
        let feed = feed
            .reconnect_with(Box::new(move || {
                next.next()
                    .unwrap_or(Err(SttFailure::Settings))
                    .map(|s| Box::new(s) as Box<dyn StreamingTranscriber>)
            }))
            .on_reconnect(move |ms| record.lock().unwrap().push(ms));
        (feed, rx, lost)
    }

    #[test]
    fn a_lost_connection_reconnects_once_and_lines_carry_on_numbering() {
        let first = Script::default();
        let second = Script::default();
        let (mut feed, rx, lost) = reconnecting(&first, vec![Ok(second.clone())]);
        feed.push(0, 1_000, &[0.1; 16_000]).unwrap();
        first.events.lock().unwrap().push(final_(1, 100, None));
        feed.poll().unwrap();
        feed.push(1_000, 3_000, &[0.1; 32_000]).unwrap();
        // The connection drops: a replacement opens, the feed carries on.
        first
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Network));
        assert_eq!(feed.poll(), Ok(()));
        assert!(*first.aborted.lock().unwrap());
        assert_eq!(feed.failure(), None);
        // The line ended at 600 ms; audio up to 3,000 ms was in flight: lost.
        assert!(
            lost.lock().unwrap().is_empty(),
            "worker start is not connection proof"
        );
        second.events.lock().unwrap().push(SttEvent::Connected {
            query: "fictional".into(),
        });
        feed.poll().unwrap();
        assert_eq!(*lost.lock().unwrap(), vec![2_400]);
        // New audio goes to the new stream, timed on the session clock, and
        // its first line is number 2, not a second number 1.
        feed.push(3_000, 4_000, &[0.1; 16_000]).unwrap();
        assert_eq!(*second.sent.lock().unwrap(), vec![16_000]);
        second.events.lock().unwrap().push(final_(1, 200, None));
        feed.poll().unwrap();
        let lines: Vec<Segment> = rx.try_iter().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].id, "c7-1-2");
        assert_eq!(lines[1].at_ms, 3_200);
    }

    #[test]
    fn pending_replacement_failure_does_not_report_success_and_keeps_the_gap() {
        let first = Script::default();
        let pending = Script::default();
        let connected = Script::default();
        let (mut feed, _, lost) =
            reconnecting(&first, vec![Ok(pending.clone()), Ok(connected.clone())]);
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        first
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Network));
        feed.poll().unwrap();
        feed.poll().unwrap();
        assert!(lost.lock().unwrap().is_empty());
        feed.push(100, 200, &[0.1; 1_600]).unwrap();
        pending
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Network));
        feed.poll().unwrap();
        assert!(lost.lock().unwrap().is_empty());
        connected.events.lock().unwrap().push(SttEvent::Connected {
            query: "fictional".into(),
        });
        feed.poll().unwrap();
        assert_eq!(*lost.lock().unwrap(), vec![200]);
        // Repeated connection messages cannot count one replacement twice.
        connected.events.lock().unwrap().push(SttEvent::Connected {
            query: "fictional".into(),
        });
        feed.poll().unwrap();
        assert_eq!(*lost.lock().unwrap(), vec![200]);
    }

    #[test]
    fn replacement_refusal_or_retired_approval_never_reports_reconnected() {
        for retired in [false, true] {
            let first = Script::default();
            let pending = Script::default();
            let approved = Arc::new(Mutex::new(true));
            let (feed, _) = feed(&first, approved.clone());
            let replacement = pending.clone();
            let lost = Arc::new(Mutex::new(Vec::new()));
            let record = lost.clone();
            let mut feed = feed
                .reconnect_with(Box::new(move || Ok(Box::new(replacement.clone()))))
                .on_reconnect(move |ms| record.lock().unwrap().push(ms));
            feed.push(0, 100, &[0.1; 1_600]).unwrap();
            first
                .events
                .lock()
                .unwrap()
                .push(SttEvent::Failed(SttFailure::Network));
            feed.poll().unwrap();
            if retired {
                *approved.lock().unwrap() = false;
                pending.events.lock().unwrap().push(SttEvent::Connected {
                    query: "fictional".into(),
                });
                assert_eq!(feed.poll(), Err(SttFailure::Withdrawn));
            } else {
                pending
                    .events
                    .lock()
                    .unwrap()
                    .push(SttEvent::Failed(SttFailure::Auth));
                assert_eq!(feed.poll(), Err(SttFailure::Auth));
            }
            assert!(lost.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn stop_drain_or_end_cannot_report_a_pending_replacement_as_reconnected() {
        for stop in [true, false] {
            let first = Script::default();
            let pending = Script::default();
            let (mut feed, _, lost) = reconnecting(&first, vec![Ok(pending.clone())]);
            feed.push(0, 100, &[0.1; 1_600]).unwrap();
            first
                .events
                .lock()
                .unwrap()
                .push(SttEvent::Failed(SttFailure::Network));
            feed.poll().unwrap();
            pending.events.lock().unwrap().push(SttEvent::Connected {
                query: "fictional".into(),
            });
            if stop {
                feed.finish(Duration::from_millis(10));
            } else {
                feed.end();
            }
            assert!(lost.lock().unwrap().is_empty(), "stop: {stop}");
        }
    }

    #[test]
    fn reconnects_stop_at_the_cap_and_never_for_a_refusal() {
        let streams: Vec<Script> = (0..=MAX_RECONNECTS as usize)
            .map(|_| Script::default())
            .collect();
        let (mut feed, _, lost) = reconnecting(
            &streams[0],
            (1..=MAX_RECONNECTS as usize)
                .map(|i| Ok(streams[i].clone()))
                .collect(),
        );
        for (n, stream) in streams.iter().enumerate() {
            stream.events.lock().unwrap().push(SttEvent::Connected {
                query: "fictional".into(),
            });
            feed.push(n as u64 * 100, n as u64 * 100 + 100, &[0.1; 1_600])
                .unwrap();
            stream
                .events
                .lock()
                .unwrap()
                .push(SttEvent::Failed(SttFailure::Stalled));
            let result = feed.poll();
            if n < MAX_RECONNECTS as usize {
                assert_eq!(result, Ok(()), "reconnect {n}");
            } else {
                assert_eq!(result, Err(SttFailure::Stalled), "the cap ends it");
            }
        }
        assert_eq!(lost.lock().unwrap().len(), MAX_RECONNECTS as usize);
        // A refused credential is not a network problem: no reconnect.
        let first = Script::default();
        let (mut feed, _, lost) = reconnecting(&first, vec![Ok(Script::default())]);
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        first
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Auth));
        assert_eq!(feed.poll(), Err(SttFailure::Auth));
        assert!(lost.lock().unwrap().is_empty());
        // A replacement that cannot open ends the feed with its own reason.
        let first = Script::default();
        let (mut feed, _, _) = reconnecting(&first, vec![Err(SttFailure::Settings)]);
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        first
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Closed));
        assert_eq!(feed.poll(), Err(SttFailure::Settings));
    }

    /// A feed with a reopener that counts how often it was called.
    fn counting(
        first: &Script,
        approved: Arc<Mutex<bool>>,
    ) -> (CloudFeed, mpsc::Receiver<Segment>, Arc<Mutex<u32>>) {
        let (feed, rx) = feed(first, approved);
        let opened = Arc::new(Mutex::new(0));
        let count = opened.clone();
        let feed = feed.reconnect_with(Box::new(move || {
            *count.lock().unwrap() += 1;
            Ok(Box::new(Script::default()) as Box<dyn StreamingTranscriber>)
        }));
        (feed, rx, opened)
    }

    #[test]
    fn a_connection_lost_after_the_review_was_withdrawn_is_not_reopened() {
        let first = Script::default();
        let approved = Arc::new(Mutex::new(true));
        let (mut feed, _, opened) = counting(&first, approved.clone());
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        *approved.lock().unwrap() = false;
        first
            .events
            .lock()
            .unwrap()
            .push(SttEvent::Failed(SttFailure::Network));
        assert_eq!(feed.poll(), Err(SttFailure::Withdrawn));
        assert_eq!(*opened.lock().unwrap(), 0);
        assert_eq!(feed.failure(), Some(SttFailure::Withdrawn));
    }

    #[test]
    fn a_connection_lost_during_stop_or_end_is_not_reopened() {
        for stop in [true, false] {
            let first = Script::default();
            let (mut feed, _, opened) = counting(&first, Arc::new(Mutex::new(true)));
            feed.push(0, 100, &[0.1; 1_600]).unwrap();
            first
                .events
                .lock()
                .unwrap()
                .push(SttEvent::Failed(SttFailure::Closed));
            if stop {
                feed.finish(Duration::from_millis(10));
            } else {
                feed.end();
            }
            assert_eq!(*opened.lock().unwrap(), 0, "stop: {stop}");
        }
    }

    #[test]
    fn a_full_queue_is_reported_once() {
        let script = Script {
            full: true,
            ..Script::default()
        };
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        let mut feed = feed(&script, Arc::new(Mutex::new(true)))
            .0
            .on_dropped(move || *count.lock().unwrap() += 1);
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        feed.push(100, 200, &[0.1; 1_600]).unwrap();
        assert_eq!(*told.lock().unwrap(), 1);
        assert_eq!(feed.stats.dropped_samples, 3_200);
    }

    #[test]
    fn one_budget_is_shared_by_every_stream_of_the_launch() {
        let budget = Budget::new(Duration::from_secs(1));
        let other = budget.clone();
        assert_eq!(budget.reserve(10_000), 10_000);
        assert_eq!(other.reserve(10_000), 6_000, "only what is left");
        assert_eq!(budget.reserve(1), 0);
    }

    #[test]
    fn a_lab_run_ending_is_its_own_stop_reason() {
        assert_eq!(withdrawal(None), None);
        assert_eq!(withdrawal(Some("lab_ended")), Some(SttFailure::LabEnded));
        assert_eq!(withdrawal(Some("withdrawn")), Some(SttFailure::Withdrawn));
    }

    #[test]
    fn a_full_queue_drops_audio_without_moving_the_clock() {
        let script = Script {
            full: true,
            ..Script::default()
        };
        let (mut feed, _) = feed(&script, Arc::new(Mutex::new(true)));
        feed.push(0, 100, &[0.1; 1_600]).unwrap();
        assert_eq!(feed.stats.dropped_samples, 1_600);
        assert_eq!(feed.clock.session_ms(0), None);
    }

    #[test]
    fn a_refused_opening_stops_the_feed() {
        let (tx, _) = mpsc::channel::<Segment>();
        let mut feed = CloudFeed::new(
            7,
            1,
            Box::new(|| Err(SttFailure::Auth)),
            || Some(0),
            move |_, s| {
                tx.send(s).unwrap();
                Ok(())
            },
        );
        assert_eq!(feed.push(0, 100, &[0.0; 1_600]), Err(SttFailure::Auth));
        assert_eq!(feed.push(0, 100, &[0.0; 1_600]), Err(SttFailure::Auth));
    }

    #[test]
    fn a_development_launch_wins_over_a_stored_key_and_otherwise_the_key_is_used() {
        use crate::provider_keys::KeyState;
        let dev = Settings {
            token_file: std::env::temp_dir().join("fictional-stt-token"),
            minute_cap: 5,
            language: Language::English,
        };
        // The lab's selection is used, even with a key stored, and an invalid
        // one is refused rather than falling back to the key.
        for key in [
            KeyState::NotSet,
            KeyState::Set,
            KeyState::Rejected,
            KeyState::Unreadable,
        ] {
            assert_eq!(
                source_for(Some(Ok(dev.clone())), Provider::Deepgram, key),
                Ok(Source::Dev(dev.clone()))
            );
            assert_eq!(
                source_for(Some(Err(SttFailure::Settings)), Provider::Deepgram, key),
                Err(ReadinessFailure::Settings)
            );
        }
        assert_eq!(
            source_for(None, Provider::Deepgram, KeyState::Set),
            Ok(Source::OwnKey(Provider::Deepgram))
        );
        assert_eq!(
            source_for(None, Provider::ElevenLabs, KeyState::Set),
            Ok(Source::OwnKey(Provider::ElevenLabs))
        );
        assert_eq!(
            source_for(None, Provider::Deepgram, KeyState::NotSet),
            Err(ReadinessFailure::NoKey)
        );
        assert_eq!(
            source_for(None, Provider::ElevenLabs, KeyState::Rejected),
            Err(ReadinessFailure::KeyRejected)
        );
        assert_eq!(
            source_for(None, Provider::Deepgram, KeyState::Unreadable),
            Err(ReadinessFailure::KeyUnreadable)
        );
        // The test build has no development selection and no stored key.
        assert!(!dev_selected());
        assert!(!selected());
        assert!(streams().is_err());
        assert_eq!(review_sentence(&SessionSources::microphone()), None);
    }

    #[test]
    fn each_start_gets_its_own_budget_and_a_second_start_cannot_touch_the_first() {
        // The first start's streams, then a second start's (as a start refused
        // at the gate would have made, were they made before it): spending
        // the second's whole budget leaves the first's untouched.
        let first = streams_for(Source::OwnKey(Provider::Deepgram), None);
        let second = streams_for(Source::OwnKey(Provider::ElevenLabs), None);
        let cap = u64::from(OWN_KEY_MINUTE_CAP) * 60 * SAMPLE_RATE as u64;
        assert_eq!(second.budget.as_ref().unwrap().reserve(u64::MAX), cap);
        assert_eq!(first.budget.as_ref().unwrap().reserve(u64::MAX), cap);
        assert!(first.reopener.is_some());
        assert!(second.reopener.is_some());
    }

    #[test]
    fn the_review_names_the_persons_key_billing_opt_out_and_session_cap() {
        let own = review_sentence_for(
            &Source::OwnKey(Provider::Deepgram),
            &SessionSources::microphone(),
        )
        .unwrap();
        for part in [
            "to Deepgram (US, model Nova-3, English)",
            "with your own Deepgram API key",
            "Deepgram bills your account for each minute of audio",
            "opt out of its Model Improvement Program",
            "https://deepgram.com/terms",
            "Audio captured before this approval is never sent",
            "At most 480 minutes of audio for this session",
            "Pausing cues does not stop the audio",
            "nothing falls back to another service",
        ] {
            assert!(own.contains(part), "missing: {part}");
        }
        let elevenlabs = review_sentence_for(
            &Source::OwnKey(Provider::ElevenLabs),
            &SessionSources::microphone(),
        )
        .unwrap();
        for part in [
            "to ElevenLabs (model Scribe v2 Realtime, English)",
            "with your own ElevenLabs API key",
            "ElevenLabs bills your account for usage",
            "https://elevenlabs.io/terms",
            "Audio captured before this approval is never sent",
            "At most 480 minutes of audio for this session",
            "Pausing cues does not stop the audio",
            "nothing falls back to another service",
        ] {
            assert!(elevenlabs.contains(part), "missing: {part}");
        }
        assert!(!elevenlabs.contains("Model Improvement Program"));
        // The development wording is unchanged.
        let dev = review_sentence_for(
            &Source::Dev(Settings {
                token_file: std::env::temp_dir().join("fictional-stt-token"),
                minute_cap: 5,
                language: Language::English,
            }),
            &SessionSources::microphone(),
        )
        .unwrap();
        assert!(dev.contains("At most 5 minutes of audio for this whole launch"));
        assert!(!dev.contains("your own"));
    }

    #[test]
    fn the_review_names_exactly_the_sessions_sources() {
        let own = |sources: &SessionSources| {
            review_sentence_with(
                &Source::OwnKey(Provider::Deepgram),
                Language::English,
                sources,
            )
            .unwrap()
        };
        let microphone = own(&SessionSources::microphone());
        assert!(microphone.contains("sends the live audio from your microphone to Deepgram"));
        assert!(!microphone.contains("application"));
        assert!(!microphone.contains("both"));
        let alone = own(&SessionSources::application((
            "Fictional Call",
            "fictional-call",
        )));
        assert!(alone.contains("the live audio of Fictional Call (audio from all of its windows may be included), not your microphone,"));
        let both = own(&SessionSources::both(("Fictional Call", "fictional-call")));
        for part in [
            "from your microphone and, as a second stream, from Fictional Call (audio from all of its windows may be included)",
            "each minute of audio of each stream",
            "At most 480 minutes of audio for this session, counted across both streams",
            "turning processing off or Stop does, for both",
        ] {
            assert!(both.contains(part), "missing: {part}");
        }
        // The old wording that named one of two possible sources is gone.
        for sentence in [microphone, alone, both] {
            assert!(!sentence.contains("the microphone, or the selected application"));
        }
    }

    #[test]
    fn a_second_source_spends_the_first_sources_budget() {
        let first = streams_for(Source::OwnKey(Provider::Deepgram), None);
        let second = streams_for(Source::OwnKey(Provider::Deepgram), first.budget());
        let cap = u64::from(OWN_KEY_MINUTE_CAP) * 60 * SAMPLE_RATE as u64;
        // The application's stream uses 40 minutes; the microphone's stream
        // has only the rest of the session's 480.
        let forty = 40 * 60 * SAMPLE_RATE as u64;
        assert_eq!(second.budget().unwrap().reserve(forty), forty);
        assert_eq!(first.budget().unwrap().reserve(u64::MAX), cap - forty);
        assert_eq!(second.budget().unwrap().reserve(1), 0);
        // A second source without the session's budget is refused, never
        // given a fresh 480 minutes.
        assert!(joining_streams(Source::OwnKey(Provider::Deepgram), None).is_err());
        let joined = joining_streams(Source::OwnKey(Provider::Deepgram), first.budget()).unwrap();
        assert_eq!(
            joined.budget().unwrap().reserve(1),
            0,
            "the same, spent budget"
        );
    }

    #[test]
    fn the_language_is_named_in_the_review_and_set_for_the_next_session() {
        let english = review_sentence_with(
            &Source::OwnKey(Provider::Deepgram),
            Language::English,
            &SessionSources::microphone(),
        )
        .unwrap();
        assert!(english.contains("Deepgram (US, model Nova-3, English)"));
        assert!(!english.contains("higher rate"));
        let multi = review_sentence_with(
            &Source::OwnKey(Provider::Deepgram),
            Language::Multilingual,
            &SessionSources::microphone(),
        )
        .unwrap();
        assert!(multi.contains(
            "Deepgram (US, model Nova-3, Multilingual, which Deepgram bills at a higher rate than English)"
        ));
        let el_multi = review_sentence_with(
            &Source::OwnKey(Provider::ElevenLabs),
            Language::Multilingual,
            &SessionSources::microphone(),
        )
        .unwrap();
        assert!(el_multi.contains(
            "ElevenLabs (model Scribe v2 Realtime, Multilingual (automatic language detection))"
        ));
        assert!(!el_multi.contains("higher rate"));
        // No price is stated.
        assert!(!multi.contains('$'));
        // The setting, as the commands see it: English until changed.
        assert_eq!(
            serde_json::to_value(Language::Multilingual).unwrap(),
            "multi"
        );
        assert_eq!(
            serde_json::from_value::<Language>(serde_json::json!("en")).unwrap(),
            Language::English
        );
        assert!(serde_json::from_value::<Language>(serde_json::json!("de")).is_err());
    }

    #[test]
    fn development_settings_are_exact() {
        let parse = |backend: Option<&str>, file: Option<&str>, cap: Option<&str>| {
            Settings::parse(|key| match key {
                "TALKQTE_DEV_STT_BACKEND" => backend.map(str::to_string),
                "TALKQTE_DEV_STT_TOKEN_FILE" => file.map(str::to_string),
                "TALKQTE_DEV_STT_MINUTE_CAP" => cap.map(str::to_string),
                _ => None,
            })
        };
        // Absolute on every platform; the file itself is never read here.
        let absolute = std::env::temp_dir().join("fictional-stt-token");
        let absolute = absolute.to_str().unwrap();
        let good = parse(Some("deepgram"), Some(absolute), Some("5")).unwrap();
        assert_eq!(good.cap(), Duration::from_secs(300));
        // A lab plan keeps English unless it asks for multilingual.
        assert_eq!(good.language, Language::English);
        let with = |language: &str| {
            Settings::parse(|key| match key {
                "TALKQTE_DEV_STT_BACKEND" => Some("deepgram".into()),
                "TALKQTE_DEV_STT_TOKEN_FILE" => Some(absolute.into()),
                "TALKQTE_DEV_STT_MINUTE_CAP" => Some("5".into()),
                "TALKQTE_DEV_STT_LANGUAGE" => Some(language.into()),
                _ => None,
            })
        };
        assert_eq!(with("en").unwrap().language, Language::English);
        assert_eq!(with("multi").unwrap().language, Language::Multilingual);
        for refused in ["", "EN", "multi ", "de", "auto"] {
            assert_eq!(with(refused), Err(SttFailure::Settings), "{refused}");
        }
        let file = Some(absolute);
        for (backend, file, cap) in [
            (Some("Deepgram"), file, Some("5")),
            (Some("deepgram"), Some("relative/t"), Some("5")),
            (Some("deepgram"), None, Some("5")),
            (Some("deepgram"), file, None),
            (Some("deepgram"), file, Some("0")),
            (Some("deepgram"), file, Some("61")),
            (Some("deepgram"), file, Some("05")),
            (Some("deepgram"), file, Some("1.5")),
        ] {
            assert_eq!(parse(backend, file, cap), Err(SttFailure::Settings));
        }
    }

    #[cfg(unix)]
    #[test]
    fn readiness_diagnostic_uses_metadata_only_and_preserves_placeholder_acceptance() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("tq-stt-ready-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let file = base.join("placeholder");
        let settings = || {
            Ok(Settings {
                token_file: file.clone(),
                minute_cap: 5,
                language: Language::English,
            })
        };
        assert_eq!(
            readiness_for(Err(SttFailure::Settings)),
            Err(ReadinessFailure::Settings)
        );
        assert_eq!(
            readiness_for(settings()),
            Err(ReadinessFailure::TokenMetadata)
        );
        std::fs::write(&file, b"").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(readiness_for(settings()), Ok(()));
        assert_eq!(check_token_file(&file), Ok(()));
        assert_eq!(
            read_token(&file),
            Err(SttFailure::Settings),
            "metadata readiness grants no usable token"
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            readiness_for(settings()),
            Err(ReadinessFailure::TokenMetadata)
        );
        assert_eq!(check_token_file(&file), Err(SttFailure::Settings));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            readiness_for(settings()),
            Err(ReadinessFailure::TokenMetadata)
        );
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(base.join("absent"), &file).unwrap();
        assert_eq!(
            readiness_for(settings()),
            Err(ReadinessFailure::TokenMetadata)
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_must_be_owner_only_and_is_never_echoed() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("tq-stt-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let file = base.join("token");
        let token = "fictional.token_".to_string() + &"x".repeat(40);
        std::fs::write(&file, format!("{token}\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_token(&file).unwrap(), token);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_token(&file), Err(SttFailure::Settings));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(read_token(&file), Err(SttFailure::Settings));
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(read_token(&link), Err(SttFailure::Settings));
        std::fs::write(&file, "short").unwrap();
        assert_eq!(read_token(&file), Err(SttFailure::Settings));
        assert!(!format!("{:?}", read_token(&file)).contains(&token));
        std::fs::remove_dir_all(&base).unwrap();
    }
    #[cfg(all(unix, feature = "timing-log", feature = "cloud-transcription"))]
    mod paired {
        use super::*;
        include!("cloud_paired_tests.rs");
    }
}
