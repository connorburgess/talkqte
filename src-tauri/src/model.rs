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
/// published, so the upstream whisper.cpp repository is the only source.
pub const TINY_EN: Spec = Spec {
    name: "tiny.en",
    file: "ggml-tiny.en.bin",
    bytes: 77_704_715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    sources: &["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"],
};

/// Free space kept beyond the model itself, so a download never fills a disk.
pub const SPACE_MARGIN: u64 = 512 * 1024 * 1024;
/// Attempts per source, resuming from what was already received.
pub const ATTEMPTS: usize = 3;
const PART_SUFFIX: &str = ".part";

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
    fn get(&self, url: &str, offset: u64) -> Result<Response, String>;
}

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
            for _ in 0..ATTEMPTS {
                if cancel.load(Ordering::Acquire) {
                    return Err(Failure::Cancelled);
                }
                match fetch_into(&part, spec, source, fetch, &mut progress, cancel)? {
                    Fetched::Complete => {}
                    Fetched::Interrupted(why) => {
                        reason = why;
                        continue;
                    }
                }
                let matches = sha256_of(&part)
                    .map_err(|error| Failure::Storage(error.to_string()))?
                    == spec.sha256;
                if !matches {
                    reason = "The downloaded file did not match the expected checksum.".into();
                    let _ = fs::remove_file(&part);
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
    let response = match fetch.get(source, offset) {
        Ok(response) => response,
        Err(why) => return Ok(Fetched::Interrupted(why)),
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

/// The HTTPS fetcher, built only with local transcription.
#[cfg(feature = "local-whisper")]
pub struct Https;

#[cfg(feature = "local-whisper")]
impl Fetch for Https {
    fn get(&self, url: &str, offset: u64) -> Result<Response, String> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_connect(Some(std::time::Duration::from_secs(15)))
            .timeout_recv_body(Some(std::time::Duration::from_secs(30)))
            .https_only(true)
            .build()
            .into();
        let mut request = agent.get(url).header("User-Agent", "TalkQTE");
        if offset > 0 {
            request = request.header("Range", &format!("bytes={offset}-"));
        }
        let response = request
            .call()
            .map_err(|_| String::from("The download server could not be reached."))?;
        let resumed = response.status().as_u16() == 206;
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
    }

    impl Fake {
        fn new(files: Vec<Vec<u8>>) -> Self {
            Self {
                files,
                cut_after: Mutex::new(vec![]),
                honor_range: true,
                requests: Mutex::new(vec![]),
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
        fn get(&self, url: &str, offset: u64) -> Result<Response, String> {
            self.requests.lock().unwrap().push((url.into(), offset));
            let index: usize = url.trim_start_matches("test://").parse().unwrap();
            let file = self.files.get(index).ok_or("unreachable")?;
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
