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

/// Feeds one capture source's audio to one stream and its finals to the
/// engine. Before approval nothing is sent: audio is discarded, not queued.
pub struct CloudFeed {
    session: u64,
    stream_index: u64,
    approved: Box<dyn FnMut() -> bool + Send>,
    opener: Option<Opener>,
    stream: Option<Box<dyn StreamingTranscriber>>,
    clock: StreamClock,
    sink: Sink,
    last_at: u64,
    failure: Option<SttFailure>,
    on_failure: Option<Box<dyn FnMut(SttFailure) + Send>>,
    keep: Option<Box<dyn FnMut() -> bool + Send>>,
    pub stats: CloudStats,
}

impl CloudFeed {
    pub fn new(
        session: u64,
        stream_index: u64,
        opener: Opener,
        approved: impl FnMut() -> bool + Send + 'static,
        sink: impl FnMut(u64, Segment) -> Result<(), String> + Send + 'static,
    ) -> Self {
        Self {
            session,
            stream_index,
            approved: Box::new(approved),
            opener: Some(opener),
            stream: None,
            clock: StreamClock::default(),
            sink: Box::new(sink),
            last_at: 0,
            failure: None,
            on_failure: None,
            keep: None,
            stats: CloudStats::default(),
        }
    }

    /// Called once, from the feeding thread, when the stream ends with a
    /// failure, so the session can stop and say why.
    pub fn on_failure(mut self, notify: impl FnMut(SttFailure) + Send + 'static) -> Self {
        self.on_failure = Some(Box::new(notify));
        self
    }

    /// Once the stream is open, it keeps sending while `keep` holds, instead
    /// of while the opening approval holds: a Stop in progress closes the
    /// review but still sends the last queued audio.
    pub fn keep_sending_while(mut self, keep: impl FnMut() -> bool + Send + 'static) -> Self {
        self.keep = Some(Box::new(keep));
        self
    }

    /// The failure that ended this feed, if any.
    pub fn failure(&self) -> Option<SttFailure> {
        self.failure
    }

    /// Audio captured from `start_ms` to `end_ms` on the session clock.
    pub fn push(&mut self, start_ms: u64, end_ms: u64, samples: &[f32]) -> Result<(), SttFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        // Turning the review off stops sending at once; the stream is not
        // reopened for this session.
        if self.stream.is_some() && !self.keeps_sending() {
            return Err(self.fail(SttFailure::Withdrawn));
        }
        if self.stream.is_none() {
            if !(self.approved)() {
                return Ok(());
            }
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
                    });
                    self.stream = Some(stream);
                }
                Err(failure) => return Err(self.fail(failure)),
            }
        }
        let stream = self.stream.as_mut().expect("stream opened");
        match stream.push(samples) {
            Ok(()) => {
                self.clock.record(start_ms, end_ms, samples.len() as u64);
                self.stats.sent_ms += samples.len() as u64 * 1_000 / SAMPLE_RATE as u64;
            }
            Err(Full) => self.stats.dropped_samples += samples.len() as u64,
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

    fn keeps_sending(&mut self) -> bool {
        match self.keep.as_mut() {
            Some(keep) => keep(),
            None => (self.approved)(),
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
        "Also sends the audio of the selected capture source, live, to Deepgram (US, model Nova-3) for transcription, with Deepgram's per-request opt-out (no retention after each response, no model training), at most {} minutes this run. Transcription starts only after this approval; if it stops, nothing is transcribed and no on-device fallback is used.",
        settings.minute_cap
    ))
}

/// Reads a short-lived token from an owner-only file: a 0600 regular file,
/// not a symlink, at most 4 KiB, owned by this user, in a 0700 directory
/// owned by this user. The token is never logged.
#[cfg(unix)]
pub fn read_token(path: &std::path::Path) -> Result<String, SttFailure> {
    use std::{
        fs::{self, OpenOptions},
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let parent = path.parent().ok_or(SttFailure::Settings)?;
    let dir = fs::symlink_metadata(parent).map_err(|_| SttFailure::Settings)?;
    // SAFETY: geteuid has no arguments or side effects.
    let uid = unsafe { libc::geteuid() };
    if !dir.is_dir() || dir.uid() != uid || dir.mode() & 0o777 != 0o700 {
        return Err(SttFailure::Settings);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| SttFailure::Settings)?;
    let meta = file.metadata().map_err(|_| SttFailure::Settings)?;
    if !meta.is_file() || meta.uid() != uid || meta.mode() & 0o777 != 0o600 || meta.len() > 4096 {
        return Err(SttFailure::Settings);
    }
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
            move || *approved.lock().unwrap(),
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
            .keep_sending_while(move || *flag.lock().unwrap());
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
            .keep_sending_while(|| true);
        never.push(0, 100, &[0.1; 1_600]).unwrap();
        assert!(unopened.sent.lock().unwrap().is_empty());
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
            || true,
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
        let good = parse(
            Some("deepgram"),
            Some("/fictional/run/stt-token"),
            Some("5"),
        )
        .unwrap();
        assert_eq!(good.cap(), Duration::from_secs(300));
        for (backend, file, cap) in [
            (Some("Deepgram"), Some("/f/t"), Some("5")),
            (Some("deepgram"), Some("relative/t"), Some("5")),
            (Some("deepgram"), None, Some("5")),
            (Some("deepgram"), Some("/f/t"), None),
            (Some("deepgram"), Some("/f/t"), Some("0")),
            (Some("deepgram"), Some("/f/t"), Some("61")),
            (Some("deepgram"), Some("/f/t"), Some("05")),
            (Some("deepgram"), Some("/f/t"), Some("1.5")),
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
