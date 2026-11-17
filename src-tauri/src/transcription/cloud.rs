//! Cloud streaming transcription, beside the chunked recognizer path.
//!
//! A `StreamingTranscriber` receives 16 kHz mono audio as it is captured and
//! returns partial and final results. Only finals become engine segments.
//! A provider's speaker label is kept as an untrusted field for the timing
//! log only: it is never shown and never sent to a cue model.
//!
//! Nothing is sent before the session's processing review is approved: until
//! then `CloudFeed` discards audio. In development builds the provider is
//! selected by `TALKQTE_DEV_STT_BACKEND`, and the only credential the app
//! sees is a short-lived token in an owner-only file; release builds have no
//! cloud transcription.

use super::SAMPLE_RATE;
use crate::engine::Segment;
use std::time::Duration;

/// The only provider implemented, as the app names it.
pub const PROVIDER: &str = "Deepgram";

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
            stats: CloudStats::default(),
        }
    }

    /// Called once, from the feeding thread, when the stream ends with a
    /// failure, so the session can stop and say why.
    pub fn on_failure(mut self, notify: impl FnMut(SttFailure) + Send + 'static) -> Self {
        self.on_failure = Some(Box::new(notify));
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
                    });
                    self.approved_at = approved_at;
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
                    return Err(self.fail(SttFailure::Stalled));
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
                    crate::timing_log::record(crate::timing_log::Event::SttState {
                        session: self.session,
                        state: "connected",
                        code: None,
                        audio_ms: self.stats.sent_ms,
                        query: Some(query),
                    });
                }
                SttEvent::Final {
                    seq,
                    text,
                    start_ms,
                    end_ms,
                    untrusted_speaker,
                } => {
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
                SttEvent::Failed(failure) => return Err(self.fail(failure)),
            }
        }
        Ok(())
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
        });
    }
}

/// Development settings for cloud transcription.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub token_file: std::path::PathBuf,
    pub minute_cap: u32,
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
        Ok(Self {
            token_file,
            minute_cap,
        })
    }

    pub fn cap(&self) -> Duration {
        Duration::from_secs(u64::from(self.minute_cap) * 60)
    }
}

/// Whether this launch asked for cloud transcription. Only a debug build
/// reads the setting; a release build never selects it.
pub fn selected() -> bool {
    cfg!(debug_assertions) && std::env::var_os("TALKQTE_DEV_STT_BACKEND").is_some()
}

/// The launch's settings, read once.
pub fn settings() -> Result<Settings, SttFailure> {
    static SETTINGS: std::sync::OnceLock<Result<Settings, SttFailure>> = std::sync::OnceLock::new();
    SETTINGS
        .get_or_init(|| {
            if !selected() {
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

/// Whether this launch can transcribe: its settings parse and the token
/// file passes the owner-only checks. The token itself is not read until a
/// stream opens, so a bad setup is reported before anyone is asked to
/// approve anything.
pub fn ready() -> Result<(), SttFailure> {
    let settings = settings()?;
    check_token_file(&settings.token_file)
}

/// The opener for this launch's selected cloud provider. It reads the token
/// file only when the stream opens, after the review is approved. Refused
/// when the settings are invalid or this build has no cloud transcription;
/// there is never a fallback to another recognizer.
pub fn opener() -> Result<Opener, SttFailure> {
    let settings = settings()?;
    #[cfg(feature = "cloud-transcription")]
    {
        Ok(super::deepgram::opener(settings))
    }
    #[cfg(not(feature = "cloud-transcription"))]
    {
        let _ = settings;
        Err(SttFailure::Settings)
    }
}

/// The sentence the session review adds when cloud transcription is
/// selected, so one approval covers both exports.
pub fn review_sentence() -> Option<String> {
    let settings = settings().ok()?;
    Some(format!(
        "Audio: this approval also sends the live audio of the session's capture source (the microphone, or the selected application) to Deepgram (US, model Nova-3) for transcription. Each request asks Deepgram to opt out of its Model Improvement Program; what Deepgram keeps is set by its terms (https://deepgram.com/terms). Audio captured before this approval is never sent. At most {} minutes of audio for this whole launch, across sessions and sources. If transcription stops, nothing is transcribed and nothing falls back to another service.",
        settings.minute_cap
    ))
}

/// The audio destination the session review names beside the cue
/// destination, when cloud transcription is selected.
pub fn audio_destination() -> Option<String> {
    settings()
        .ok()
        .map(|_| "Deepgram (US), for transcription of the session's audio".to_string())
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
}
