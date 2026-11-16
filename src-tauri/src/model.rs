//! Optional speech model download: fetches a pinned model file into the app's
//! own storage, resumes after a dropped connection, checks free space first,
//! and moves the file into place only after its SHA-256 matches. A partial or
//! unverified file never counts as installed. Network access goes through
//! `Fetch`, so every failure case is tested without the network.

use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

/// A model this app version accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    pub name: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    /// Tried in order; each copy must match `sha256`.
    pub sources: &'static [&'static str],
}

/// The default local model. The project's own release copy is not yet
/// published, so the upstream whisper.cpp repository on Hugging Face is the
/// only source, pinned to a fixed revision rather than a moving branch.
pub const TINY_EN: Spec = Spec {
    name: "tiny.en",
    file: "ggml-tiny.en.bin",
    bytes: 77_704_715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    sources: &["https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin"],
};

/// Free space kept beyond the model itself, so a download never fills a disk.
pub const SPACE_MARGIN: u64 = 512 * 1024 * 1024;
/// Attempts per source that receive nothing new before giving up. An attempt
/// that makes progress does not count, so a slow connection keeps resuming.
pub const ATTEMPTS: usize = 3;
const PART_SUFFIX: &str = ".part";
/// The wait after a failed attempt that received nothing, doubling each time.
const STALL_WAIT: std::time::Duration = if cfg!(test) {
    std::time::Duration::from_millis(20)
} else {
    std::time::Duration::from_secs(2)
};

/// Waits `STALL_WAIT × 2^(failures − 1)`, checking `cancel` every 50 ms.
/// Returns true if the download was cancelled during the wait.
fn wait_or_cancel(failures: usize, cancel: &AtomicBool) -> bool {
    let total = STALL_WAIT * (1 << (failures.saturating_sub(1)).min(4)) as u32;
    wait_for(total, cancel)
}

/// Waits `total`, checking `cancel` every 50 ms; true if cancelled.
fn wait_for(total: std::time::Duration, cancel: &AtomicBool) -> bool {
    let step = std::time::Duration::from_millis(50).min(total);
    let started = std::time::Instant::now();
    while started.elapsed() < total {
        if cancel.load(Ordering::Acquire) {
            return true;
        }
        std::thread::sleep(step);
    }
    cancel.load(Ordering::Acquire)
}

/// One response from a source, starting at the requested offset or, if the
/// server ignored the range, at the beginning.
pub struct Response {
    /// True when the body starts at the requested offset.
    pub resumed: bool,
    pub body: Box<dyn Read + Send>,
}

/// Requests `url` from byte `offset`. Implementations must not send anything
/// beyond an ordinary file request.
pub trait Fetch {
    fn get(&self, url: &str, offset: u64) -> Result<Response, FetchError>;
}

/// Why a request produced no body, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// Worth trying again after a short wait: a connection or server fault.
    Transient(String),
    /// The server asked for a pause; `retry_after` is its stated reset time.
    RateLimited {
        retry_after: Option<std::time::Duration>,
    },
    /// Trying again will not help: the file is missing or access is refused.
    Permanent(String),
    /// The server rejected the resume offset; the partial file is stale.
    RangeNotSatisfiable,
}

/// The longest wait honored from a rate-limit response.
pub const RATE_LIMIT_WAIT_CAP: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Cancelled,
    NoSpace {
        needed: u64,
        available: u64,
    },
    /// Every source failed or served a file with the wrong checksum.
    Unavailable(String),
    Storage(String),
}

impl Failure {
    pub fn message(&self) -> String {
        match self {
            Failure::Cancelled => "Download cancelled. Nothing was installed.".into(),
            Failure::NoSpace { needed, .. } => format!(
                "Not enough free space. The model needs about {} MB free.",
                needed.div_ceil(1_000_000)
            ),
            Failure::Unavailable(reason) => {
                format!("The model could not be downloaded. {reason} Nothing was installed.")
            }
            Failure::Storage(_) => "The model could not be saved. Nothing was installed.".into(),
        }
    }
}

pub fn installed_path(dir: &Path, spec: &Spec) -> PathBuf {
    dir.join(spec.file)
}

fn part_path(dir: &Path, spec: &Spec) -> PathBuf {
    dir.join(format!(".{}{PART_SUFFIX}", spec.file))
}

/// True when the model file is present with the expected size. Its contents
/// are checked by `verify` before it is loaded.
pub fn is_installed(dir: &Path, spec: &Spec) -> bool {
    fs::metadata(installed_path(dir, spec))
        .is_ok_and(|meta| meta.is_file() && meta.len() == spec.bytes)
}

fn sha256_of(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Checks an installed model's size and checksum before it is loaded.
pub fn verify(path: &Path, spec: &Spec) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|_| "The local speech model is not installed.")?;
    if meta.len() != spec.bytes
        || sha256_of(path).map_err(|_| "The local speech model could not be read.")? != spec.sha256
    {
        return Err("The local speech model is damaged. Remove it and download it again.".into());
    }
    Ok(())
}

/// Deletes the installed model and any partial download.
pub fn remove(dir: &Path, spec: &Spec) -> io::Result<()> {
    for path in [installed_path(dir, spec), part_path(dir, spec)] {
        match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// Removes partial downloads left by an earlier run; call at launch.
pub fn clean_partials(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') && name.ends_with(PART_SUFFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Downloads `spec` into `dir`. `available` reports free space at `dir`
/// (`None` skips the check where it cannot be measured). `progress` receives
/// bytes received so far and the total. `cancel` is checked between reads;
/// a cancelled or failed download leaves no partial file and no model.
pub fn download(
    dir: &Path,
    spec: &Spec,
    fetch: &dyn Fetch,
    available: impl Fn(&Path) -> Option<u64>,
    mut progress: impl FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<PathBuf, Failure> {
    fs::create_dir_all(dir).map_err(|error| Failure::Storage(error.to_string()))?;
    let part = part_path(dir, spec);
    let result = (|| {
        let needed = spec.bytes + SPACE_MARGIN;
        if let Some(available) = available(dir) {
            if available < needed {
                return Err(Failure::NoSpace { needed, available });
            }
        }
        let mut reason = String::from("Check your connection and try again.");
        for source in spec.sources {
            // Each source starts afresh, so one copy is never mixed with another.
            let _ = fs::remove_file(&part);
            let (mut stalled, mut fresh_retry) = (0, false);
            while stalled < ATTEMPTS {
                if cancel.load(Ordering::Acquire) {
                    return Err(Failure::Cancelled);
                }
                let before = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
                match fetch_into(&part, spec, source, fetch, &mut progress, cancel)? {
                    Fetched::Complete => {}
                    Fetched::Refused(why) => {
                        // This source will not serve the file; try the next.
                        reason = why;
                        break;
                    }
                    Fetched::RateLimited(retry_after) => {
                        // Honor the server's reset time, within a cap, before
                        // counting the attempt; Cancel still ends the wait.
                        reason = "The download server asked us to wait.".into();
                        stalled += 1;
                        if stalled < ATTEMPTS {
                            let wait = retry_after
                                .unwrap_or(STALL_WAIT * 4)
                                .min(RATE_LIMIT_WAIT_CAP);
                            if wait_for(wait, cancel) {
                                return Err(Failure::Cancelled);
                            }
                        }
                        continue;
                    }
                    Fetched::Interrupted(why) => {
                        reason = why;
                        let after = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
                        // Any change, including a restart from zero by a
                        // server that ignores ranges, counts as progress.
                        if after == before {
                            stalled += 1;
                            // A busy server gets time before the next try;
                            // Cancel still ends the wait.
                            if stalled < ATTEMPTS && wait_or_cancel(stalled, cancel) {
                                return Err(Failure::Cancelled);
                            }
                        }
                        continue;
                    }
                }
                let matches = sha256_of(&part)
                    .map_err(|error| Failure::Storage(error.to_string()))?
                    == spec.sha256;
                if !matches {
                    reason = "The downloaded file did not match the expected checksum.".into();
                    let _ = fs::remove_file(&part);
                    // One clean retry, in case a resume joined two versions.
                    if !fresh_retry {
                        fresh_retry = true;
                        continue;
                    }
                    break;
                }
                let target = installed_path(dir, spec);
                fs::rename(&part, &target).map_err(|error| Failure::Storage(error.to_string()))?;
                return Ok(target);
            }
        }
        Err(Failure::Unavailable(reason))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

enum Fetched {
    Complete,
    Interrupted(String),
    RateLimited(Option<std::time::Duration>),
    Refused(String),
}

/// Appends to the partial file from where it stopped. Returns `Interrupted`
/// for a failure worth retrying, and `Err` for cancellation or storage.
fn fetch_into(
    part: &Path,
    spec: &Spec,
    source: &str,
    fetch: &dyn Fetch,
    progress: &mut impl FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<Fetched, Failure> {
    let storage = |error: io::Error| Failure::Storage(error.to_string());
    let offset = fs::metadata(part).map(|meta| meta.len()).unwrap_or(0);
    if offset == spec.bytes {
        // Everything arrived before the connection failed; check it as is.
        return Ok(Fetched::Complete);
    }
    let response = match fetch.get(source, offset) {
        Ok(response) => response,
        Err(FetchError::Transient(why)) => return Ok(Fetched::Interrupted(why)),
        Err(FetchError::RateLimited { retry_after }) => {
            return Ok(Fetched::RateLimited(retry_after))
        }
        Err(FetchError::Permanent(why)) => return Ok(Fetched::Refused(why)),
        Err(FetchError::RangeNotSatisfiable) => {
            // Start over: the file size changes, so this counts as progress.
            let _ = fs::remove_file(part);
            return Ok(Fetched::Interrupted(
                "The server could not resume the download.".into(),
            ));
        }
    };
    let (mut file, mut received) = if response.resumed && offset > 0 {
        (
            OpenOptions::new()
                .append(true)
                .open(part)
                .map_err(storage)?,
            offset,
        )
    } else {
        (File::create(part).map_err(storage)?, 0)
    };
    let mut body = response.body;
    let mut buffer = vec![0; 1 << 16];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(Failure::Cancelled);
        }
        let read = match body.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(Fetched::Interrupted("The connection dropped.".into())),
        };
        if read == 0 {
            break;
        }
        received += read as u64;
        if received > spec.bytes {
            // Not the expected file; drop it and let the next attempt restart.
            drop(file);
            let _ = fs::remove_file(part);
            return Ok(Fetched::Interrupted(
                "The server sent an unexpected file.".into(),
            ));
        }
        file.write_all(&buffer[..read]).map_err(storage)?;
        progress(received, spec.bytes);
    }
    file.sync_all().map_err(storage)?;
    Ok(if received == spec.bytes {
        Fetched::Complete
    } else {
        Fetched::Interrupted("The connection dropped.".into())
    })
}

/// Free space on the volume holding `path`, where it can be measured.
pub fn available_space(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `path` is a valid C string and `stats` is written by the call.
        if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: statvfs returned 0, so `stats` is initialized.
        let stats = unsafe { stats.assume_init() };
        #[allow(clippy::unnecessary_cast)] // The field types differ by platform.
        Some(stats.f_bavail as u64 * stats.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// The HTTPS fetcher. The app uses it only with local transcription; tests
/// build it too, to check what a request carries.
#[cfg(any(feature = "local-whisper", test))]
pub struct Https;

#[cfg(any(feature = "local-whisper", test))]
impl Fetch for Https {
    fn get(&self, url: &str, offset: u64) -> Result<Response, FetchError> {
        request_file(url, offset, true)
    }
}

/// One file request. `https_only` is false only in a test against a
/// loopback server; the app always passes true.
#[cfg(any(feature = "local-whisper", test))]
fn request_file(url: &str, offset: u64, https_only: bool) -> Result<Response, FetchError> {
    {
        use std::time::Duration;
        // Every step has a limit, so a silent server cannot hold a download
        // (or its Cancel) for long. The body limit covers one attempt; a
        // slow connection resumes in the next, which does not count as a
        // failure while it makes progress.
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_resolve(Some(Duration::from_secs(15)))
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_send_request(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .https_only(https_only)
            // Statuses are read here, so a rate limit and a missing file
            // can be told apart from a dropped connection.
            .http_status_as_error(false)
            .build()
            .into();
        let mut request = agent.get(url).header("User-Agent", "TalkQTE");
        if offset > 0 {
            request = request.header("Range", &format!("bytes={offset}-"));
        }
        let response = request.call().map_err(|_| {
            FetchError::Transient("The download server could not be reached.".into())
        })?;
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        match response.status().as_u16() {
            200 | 206 => {}
            429 | 503 => {
                // Retry-After as delta seconds (a date form is not parsed
                // and falls back to the default wait), or the IETF RateLimit
                // header's "t=" reset time.
                let retry_after = header("retry-after")
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .or_else(|| {
                        header("ratelimit").and_then(|value| {
                            value
                                .split([',', ';'])
                                .map(str::trim)
                                .find_map(|part| part.strip_prefix("t=")?.parse::<u64>().ok())
                        })
                    })
                    .map(Duration::from_secs);
                return Err(FetchError::RateLimited { retry_after });
            }
            416 => return Err(FetchError::RangeNotSatisfiable),
            403 | 404 | 410 => {
                return Err(FetchError::Permanent(
                    "The model file is not available from this source.".into(),
                ))
            }
            status => {
                return Err(FetchError::Transient(format!(
                    "The download server answered with status {status}."
                )))
            }
        }
        // A partial response must start exactly where the file stopped.
        let resumed = response.status().as_u16() == 206;
        if resumed {
            let starts_at_offset = response
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|range| range.starts_with(&format!("bytes {offset}-")));
            if !starts_at_offset {
                return Err(FetchError::Transient(
                    "The server resumed at the wrong place.".into(),
                ));
            }
        }
        let body = response.into_body().into_reader();
        Ok(Response {
            resumed,
            body: Box::new(body),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serves fixed bytes; can stop early, ignore ranges, or fail outright.
    struct Fake {
        files: Vec<Vec<u8>>,
        cut_after: Mutex<Vec<Option<usize>>>,
        honor_range: bool,
        requests: Mutex<Vec<(String, u64)>>,
        times: Mutex<Vec<std::time::Instant>>,
        /// Errors to return instead of a body, one per request, newest last.
        errors: Mutex<Vec<FetchError>>,
        /// Set on the first request, so a cancel lands during the next wait
        /// without depending on thread timing.
        cancel_on_request: Mutex<Option<std::sync::Arc<AtomicBool>>>,
    }

    impl Fake {
        fn new(files: Vec<Vec<u8>>) -> Self {
            Self {
                files,
                cut_after: Mutex::new(vec![]),
                honor_range: true,
                requests: Mutex::new(vec![]),
                times: Mutex::new(vec![]),
                errors: Mutex::new(vec![]),
                cancel_on_request: Mutex::new(None),
            }
        }
    }

    /// Yields bytes, then an error instead of the end when cut short.
    struct Cut(io::Cursor<Vec<u8>>, bool);

    impl Read for Cut {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            match self.0.read(buffer)? {
                0 if self.1 => Err(io::ErrorKind::ConnectionReset.into()),
                read => Ok(read),
            }
        }
    }

    impl Fetch for Fake {
        fn get(&self, url: &str, offset: u64) -> Result<Response, FetchError> {
            self.requests.lock().unwrap().push((url.into(), offset));
            self.times.lock().unwrap().push(std::time::Instant::now());
            if let Some(cancel) = self.cancel_on_request.lock().unwrap().take() {
                cancel.store(true, Ordering::Release);
            }
            if let Some(error) = self.errors.lock().unwrap().pop() {
                return Err(error);
            }
            let index: usize = url.trim_start_matches("test://").parse().unwrap();
            let file = self
                .files
                .get(index)
                .ok_or(FetchError::Transient("unreachable".into()))?;
            let start = if self.honor_range { offset as usize } else { 0 };
            let mut bytes = file[start..].to_vec();
            let cut = self.cut_after.lock().unwrap().pop().flatten();
            if let Some(cut) = cut {
                bytes.truncate(cut);
            }
            Ok(Response {
                resumed: self.honor_range && offset > 0,
                body: Box::new(Cut(io::Cursor::new(bytes), cut.is_some())),
            })
        }
    }

    const BYTES: &[u8] = b"fictional model weights for tests only";

    fn real_spec(sources: &'static [&'static str]) -> Spec {
        let hex: String = Sha256::digest(BYTES)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Spec {
            name: "test",
            file: "test-model.bin",
            bytes: BYTES.len() as u64,
            sha256: Box::leak(hex.into_boxed_str()),
            sources,
        }
    }

    fn plenty(_: &Path) -> Option<u64> {
        Some(u64::MAX)
    }

    fn dir() -> tempdir::Dir {
        tempdir::Dir::new()
    }

    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let path = std::env::temp_dir().join(format!(
                    "talkqte-model-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                let _ = std::fs::remove_dir_all(&path);
                Self(path)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn a_verified_download_is_installed_and_reports_progress() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        let mut seen = vec![];
        let path = download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |received, total| seen.push((received, total)),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(is_installed(dir.path(), &spec));
        verify(&path, &spec).unwrap();
        assert_eq!(seen.last(), Some(&(spec.bytes, spec.bytes)));
        assert_eq!(leftovers(dir.path()), vec![spec.file.to_string()]);
    }

    #[test]
    fn a_dropped_connection_resumes_where_it_stopped() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        // The first response stops after 10 bytes; the retry asks for the rest.
        *fake.cut_after.lock().unwrap() = vec![None, Some(10)];
        download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let requests = fake.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|(_, offset)| *offset)
                .collect::<Vec<_>>(),
            vec![0, 10]
        );
        assert!(is_installed(dir.path(), &spec));
    }

    #[test]
    fn a_slow_connection_keeps_resuming_while_it_makes_progress() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        // Eight short responses in a row, more than ATTEMPTS, each adding bytes.
        *fake.cut_after.lock().unwrap() = vec![
            None,
            Some(4),
            Some(4),
            Some(4),
            Some(4),
            Some(4),
            Some(4),
            Some(4),
            Some(4),
        ];
        download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(fake.requests.lock().unwrap().len() > ATTEMPTS);
        assert!(is_installed(dir.path(), &spec));
    }

    #[test]
    fn a_failure_after_the_last_byte_still_installs_the_complete_file() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        // All bytes arrive, then the connection errors instead of closing.
        *fake.cut_after.lock().unwrap() = vec![Some(BYTES.len())];
        download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            fake.requests.lock().unwrap().len(),
            1,
            "no request past the end"
        );
        assert!(is_installed(dir.path(), &spec));
    }

    #[test]
    fn a_server_that_ignores_ranges_restarts_the_file_cleanly() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let mut fake = Fake::new(vec![BYTES.to_vec()]);
        fake.honor_range = false;
        *fake.cut_after.lock().unwrap() = vec![None, Some(10)];
        let path = download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        verify(&path, &spec).unwrap();
    }

    #[test]
    fn a_checksum_mismatch_tries_the_next_source_and_never_installs_the_bad_copy() {
        let dir = dir();
        let spec = real_spec(&["test://0", "test://1"]);
        let mut corrupt = BYTES.to_vec();
        corrupt[0] ^= 1;
        let fake = Fake::new(vec![corrupt.clone(), BYTES.to_vec()]);
        let path = download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        verify(&path, &spec).unwrap();

        let only_bad = Fake::new(vec![corrupt]);
        let dir = self::dir();
        let failure = download(
            dir.path(),
            &real_spec(&["test://0"]),
            &only_bad,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(failure, Failure::Unavailable(ref why) if why.contains("checksum")));
        assert!(
            leftovers(dir.path()).is_empty(),
            "no partial or bad file is kept"
        );
    }

    #[test]
    fn an_unreachable_source_fails_with_a_retryable_message_and_leaves_nothing() {
        let dir = dir();
        let spec = real_spec(&["test://7"]);
        let fake = Fake::new(vec![]);
        let failure = download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(failure, Failure::Unavailable(_)));
        assert_eq!(fake.requests.lock().unwrap().len(), ATTEMPTS);
        assert!(leftovers(dir.path()).is_empty());
        assert!(failure.message().contains("Nothing was installed"));
    }

    #[test]
    fn a_missing_file_is_not_retried_and_the_next_source_is_tried() {
        let dir = dir();
        let spec = real_spec(&["test://0", "test://1"]);
        let fake = Fake::new(vec![BYTES.to_vec(), BYTES.to_vec()]);
        fake.errors
            .lock()
            .unwrap()
            .push(FetchError::Permanent("gone".into()));
        download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let requests = fake.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            2,
            "one refusal, then the fallback, no retries"
        );
        assert_eq!(requests[1].0, "test://1");

        let only = Fake::new(vec![BYTES.to_vec()]);
        only.errors
            .lock()
            .unwrap()
            .push(FetchError::Permanent("gone".into()));
        let dir = self::dir();
        let failure = download(
            dir.path(),
            &real_spec(&["test://0"]),
            &only,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(failure, Failure::Unavailable(ref why) if why == "gone"));
        assert_eq!(only.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_rate_limit_waits_for_the_stated_reset_before_retrying() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        let reset = STALL_WAIT * 3;
        fake.errors.lock().unwrap().push(FetchError::RateLimited {
            retry_after: Some(reset),
        });
        download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let times = fake.times.lock().unwrap();
        assert_eq!(times.len(), 2);
        assert!(times[1] - times[0] >= reset);
    }

    #[test]
    fn a_rate_limit_wait_can_be_cancelled() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        fake.errors.lock().unwrap().push(FetchError::RateLimited {
            retry_after: Some(std::time::Duration::from_secs(3_600)),
        });
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        *fake.cancel_on_request.lock().unwrap() = Some(cancel.clone());
        let result = download(dir.path(), &spec, &fake, plenty, |_, _| {}, &cancel);
        assert_eq!(result.unwrap_err(), Failure::Cancelled);
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_rejected_resume_offset_restarts_the_file_from_zero() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        fs::create_dir_all(dir.path()).unwrap();
        // A stale partial file longer than the real file.
        fs::write(part_path(dir.path(), &spec), vec![0; BYTES.len() + 5]).unwrap();
        fake.errors
            .lock()
            .unwrap()
            .push(FetchError::RangeNotSatisfiable);
        download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let requests = fake.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].1, 0, "second request starts from zero");
        assert!(is_installed(dir.path(), &spec));
    }

    #[test]
    fn failed_attempts_wait_longer_each_time() {
        let dir = dir();
        let spec = real_spec(&["test://7"]);
        let fake = Fake::new(vec![]);
        let failure = download(
            dir.path(),
            &spec,
            &fake,
            plenty,
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(failure, Failure::Unavailable(_)));
        let times = fake.times.lock().unwrap();
        assert_eq!(times.len(), ATTEMPTS);
        let (first, second) = (times[1] - times[0], times[2] - times[1]);
        assert!(first >= STALL_WAIT, "{first:?}");
        assert!(second >= STALL_WAIT * 2, "doubles: {second:?}");
    }

    #[test]
    fn cancel_during_a_wait_ends_the_download_and_leaves_nothing() {
        let dir = dir();
        let spec = real_spec(&["test://7"]);
        let fake = Fake::new(vec![]);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        *fake.cancel_on_request.lock().unwrap() = Some(cancel.clone());
        let result = download(dir.path(), &spec, &fake, plenty, |_, _| {}, &cancel);
        assert_eq!(result.unwrap_err(), Failure::Cancelled);
        assert_eq!(fake.requests.lock().unwrap().len(), 1, "no second attempt");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn cancel_stops_the_download_and_removes_the_partial_file() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        let cancel = AtomicBool::new(false);
        // Cancel arrives after the first read; nothing is installed.
        assert_eq!(
            download(
                dir.path(),
                &spec,
                &fake,
                plenty,
                |_, _| cancel.store(true, Ordering::Release),
                &cancel,
            )
            .unwrap_err(),
            Failure::Cancelled
        );
        assert!(leftovers(dir.path()).is_empty());
        let cancel = AtomicBool::new(true);
        let dir = self::dir();
        assert_eq!(
            download(dir.path(), &spec, &fake, plenty, |_, _| {}, &cancel).unwrap_err(),
            Failure::Cancelled
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn too_little_free_space_is_refused_before_anything_is_fetched() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        let fake = Fake::new(vec![BYTES.to_vec()]);
        let failure = download(
            dir.path(),
            &spec,
            &fake,
            |_| Some(SPACE_MARGIN),
            |_, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(failure, Failure::NoSpace { .. }));
        assert!(fake.requests.lock().unwrap().is_empty());
        assert!(failure.message().contains("free space"));
    }

    #[test]
    fn a_damaged_model_fails_verification_and_remove_deletes_it() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        fs::create_dir_all(dir.path()).unwrap();
        let path = installed_path(dir.path(), &spec);
        let mut damaged = BYTES.to_vec();
        damaged[3] ^= 1;
        fs::write(&path, damaged).unwrap();
        assert!(is_installed(dir.path(), &spec), "size alone matches");
        assert!(verify(&path, &spec).unwrap_err().contains("damaged"));
        remove(dir.path(), &spec).unwrap();
        assert!(!is_installed(dir.path(), &spec));
        remove(dir.path(), &spec).unwrap();
    }

    #[test]
    fn partial_files_from_an_earlier_run_are_cleaned_up() {
        let dir = dir();
        let spec = real_spec(&["test://0"]);
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(part_path(dir.path(), &spec), b"half").unwrap();
        fs::write(dir.path().join("keep.txt"), b"other").unwrap();
        clean_partials(dir.path());
        assert_eq!(leftovers(dir.path()), vec!["keep.txt".to_string()]);
    }

    #[test]
    fn free_space_can_be_measured_on_this_platform() {
        if cfg!(unix) {
            assert!(available_space(&std::env::temp_dir()).is_some_and(|bytes| bytes > 0));
        }
    }

    /// A fictional file server on a loopback port that honors ranges and
    /// records each request's head and body.
    fn fictional_file_server() -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::Write;
        const FILE: &[u8] = b"0123456789";
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/fictional/ggml-tiny.en.bin",
            listener.local_addr().unwrap()
        );
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut received = Vec::new();
                let mut buffer = [0u8; 4096];
                while !received.windows(4).any(|end| end == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => received.extend_from_slice(&buffer[..read]),
                    }
                }
                let request = String::from_utf8_lossy(&received).into_owned();
                let offset = request.lines().find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("range: bytes=")?
                        .strip_suffix('-')?
                        .parse::<usize>()
                        .ok()
                });
                log.lock().unwrap().push(request);
                let head = match offset {
                    Some(offset) => format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {offset}-9/10\r\nContent-Length: {}\r\n",
                        FILE.len() - offset
                    ),
                    None => format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n", FILE.len()),
                };
                let _ = stream.write_all(format!("{head}Connection: close\r\n\r\n").as_bytes());
                let _ = stream.write_all(&FILE[offset.unwrap_or(0)..]);
            }
        });
        (url, seen)
    }

    #[test]
    fn a_download_request_carries_the_app_name_a_resume_offset_and_nothing_personal() {
        let (url, seen) = fictional_file_server();
        let read = |response: Response| {
            let mut body = vec![];
            let mut reader = response.body;
            reader.read_to_end(&mut body).unwrap();
            (response.resumed, body)
        };
        assert_eq!(
            read(request_file(&url, 0, false).unwrap()),
            (false, b"0123456789".to_vec())
        );
        assert_eq!(
            read(request_file(&url, 4, false).unwrap()),
            (true, b"456789".to_vec())
        );
        // The app's own fetcher refuses anything but HTTPS before connecting.
        assert!(Https.get(&url, 0).is_err());

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 2, "one request each, and none over plain HTTP");
        for (request, range) in seen.iter().zip([None, Some("bytes=4-")]) {
            let (head, body) = request.split_once("\r\n\r\n").unwrap();
            assert_eq!(
                head.lines().next(),
                Some("GET /fictional/ggml-tiny.en.bin HTTP/1.1"),
                "a plain file request with no query"
            );
            assert!(body.is_empty(), "nothing is uploaded");
            let headers: Vec<(String, &str)> = head
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.to_lowercase(), value.trim()))
                .collect();
            let values = |wanted: &str| -> Vec<&str> {
                headers
                    .iter()
                    .filter(|(name, _)| name == wanted)
                    .map(|(_, value)| *value)
                    .collect()
            };
            assert_eq!(values("user-agent"), ["TalkQTE"]);
            assert_eq!(values("range"), range.into_iter().collect::<Vec<_>>());
            // Only what any file request has: no account, cookie, referrer
            // or content of the person's.
            for (name, _) in &headers {
                assert!(
                    [
                        "host",
                        "user-agent",
                        "accept",
                        "accept-encoding",
                        "range",
                        "connection"
                    ]
                    .contains(&name.as_str()),
                    "unexpected header {name}"
                );
            }
        }
    }

    /// Network check, run by hand: asks the real source for the model's last
    /// 16 bytes, which shows that HTTPS, ranges, and the pinned size agree.
    /// `cargo test --features local-whisper -- --ignored source_serves`
    #[cfg(feature = "local-whisper")]
    #[test]
    #[ignore]
    fn source_serves_the_pinned_size_with_ranges() {
        for source in TINY_EN.sources {
            let response = Https.get(source, TINY_EN.bytes - 16).unwrap();
            assert!(response.resumed, "{source} ignored the range");
            let mut tail = vec![];
            response.body.take(64).read_to_end(&mut tail).unwrap();
            assert_eq!(tail.len(), 16, "{source} size differs from the pin");
        }
    }
}
