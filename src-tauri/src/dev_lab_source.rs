//! Frozen policy for one explicitly owned fictional player, never a registry.
//! Process/filesystem inspection runs on setup/owner workers, not callbacks or
//! under Runtime/host locks. The launcher separately verifies hash/signature.
use objc2_app_kit::NSRunningApplication;
use std::{os::unix::fs::MetadataExt, path::PathBuf, sync::OnceLock};

pub(crate) const PLAYER: &str = "TalkQTE Lab Player";
pub(crate) const BUNDLE: &str = "com.talkqte.lab-player";
const FIELDS: [&str; 4] = [
    "TALKQTE_DEV_PLAYER_PID",
    "TALKQTE_DEV_PLAYER_START_SEC",
    "TALKQTE_DEV_PLAYER_START_USEC",
    "TALKQTE_DEV_PLAYER_EXECUTABLE",
];
static PIN: OnceLock<Option<Pin>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    QuickTime,
    OwnedPlayer,
}
impl Kind {
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "QuickTime Player" => Some(Self::QuickTime),
            PLAYER => Some(Self::OwnedPlayer),
            _ => None,
        }
    }
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::QuickTime => "QuickTime Player",
            Self::OwnedPlayer => PLAYER,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Process {
    pid: i32,
    seconds: u64,
    micros: u64,
    executable: PathBuf,
    // Detect replacement of the canonical executable in addition to PID reuse.
    file: (u64, u64, u64, i64, i64),
}
#[derive(Debug)]
struct Pin(Process);

fn decimal(text: &str) -> Option<u64> {
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    text.parse().ok()
}

fn expected(
    source: Option<&str>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<Option<Process>, &'static str> {
    let fields = FIELDS.map(&lookup);
    let owned = source == Some(PLAYER);
    if !owned {
        return if fields.iter().any(Option::is_some) {
            Err("unexpected owned player settings")
        } else {
            Ok(None)
        };
    }
    if lookup("TALKQTE_DEV_STOP_SIGNAL").as_deref() != Some("usr2") {
        return Err("owned player requires source-only Stop");
    }
    let [Some(pid), Some(seconds), Some(micros), Some(executable)] = fields else {
        return Err("missing owned player identity");
    };
    let pid = decimal(&pid)
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or("invalid owned player PID")?;
    let seconds = decimal(&seconds)
        .filter(|n| *n > 0)
        .ok_or("invalid owned player start")?;
    let micros = decimal(&micros)
        .filter(|n| *n < 1_000_000)
        .ok_or("invalid owned player start")?;
    let executable = PathBuf::from(executable);
    if !executable.is_absolute()
        || executable.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("invalid owned player executable");
    }
    Ok(Some(Process {
        pid,
        seconds,
        micros,
        executable,
        file: (0, 0, 0, 0, 0),
    }))
}

/// What the process table says about a pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Info {
    uid: u32,
    seconds: u64,
    micros: u64,
}

/// Why the process table could not be read for a pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Missing {
    /// No such process (`ESRCH`).
    Gone,
    /// A process exists but belongs to another user (`EPERM`).
    OtherOwner,
    /// The read failed for another reason.
    Unreadable,
}

/// An executable's metadata: a regular file, its link count, and its
/// identity (device, inode, length, modification time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileInfo {
    regular: bool,
    links: u64,
    identity: (u64, u64, u64, i64, i64),
}

/// The system reads the identity check makes, so tests can stand in for a
/// replaced or briefly unreadable process.
trait Reads {
    fn uid(&self) -> u32;
    fn info(&self, pid: i32) -> Result<Info, Missing>;
    fn path(&self, pid: i32) -> Option<PathBuf>;
    fn canonical(&self, path: &std::path::Path) -> Option<PathBuf>;
    fn file(&self, path: &std::path::Path) -> Option<FileInfo>;
    /// Whether NSRunningApplication knows the pid: terminated, bundle id.
    fn running(&self, pid: i32) -> Option<(bool, Option<String>)>;
}

struct System;

impl Reads for System {
    fn uid(&self) -> u32 {
        // SAFETY: getuid has no arguments or side effects.
        unsafe { libc::getuid() }
    }

    fn info(&self, pid: i32) -> Result<Info, Missing> {
        // SAFETY: fixed-size owned buffer, exact returned struct length checked.
        let read = unsafe {
            let mut value: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of_val(&value);
            let copied = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut value as *mut libc::proc_bsdinfo).cast(),
                i32::try_from(size).unwrap_or(0),
            );
            (usize::try_from(copied).ok() == Some(size) && value.pbi_pid == pid as u32)
                .then_some(value)
        };
        if let Some(value) = read {
            return Ok(Info {
                uid: value.pbi_uid,
                seconds: value.pbi_start_tvsec,
                micros: value.pbi_start_tvusec,
            });
        }
        // SAFETY: signal 0 only checks that the process exists and may be signalled.
        let signalled = unsafe { libc::kill(pid, 0) };
        let errno = std::io::Error::last_os_error().raw_os_error();
        Err(match (signalled, errno) {
            (0, _) => Missing::Unreadable,
            (_, Some(libc::ESRCH)) => Missing::Gone,
            (_, Some(libc::EPERM)) => Missing::OtherOwner,
            _ => Missing::Unreadable,
        })
    }

    fn path(&self, pid: i32) -> Option<PathBuf> {
        let mut path = [0u8; 4096];
        // SAFETY: proc_pidpath writes at most the supplied buffer length.
        let copied =
            unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if copied <= 0 {
            return None;
        }
        let end = path.iter().position(|b| *b == 0)?;
        Some(PathBuf::from(std::str::from_utf8(&path[..end]).ok()?))
    }

    fn canonical(&self, path: &std::path::Path) -> Option<PathBuf> {
        path.canonicalize().ok()
    }

    fn file(&self, path: &std::path::Path) -> Option<FileInfo> {
        let metadata = std::fs::symlink_metadata(path).ok()?;
        Some(FileInfo {
            regular: metadata.is_file(),
            links: metadata.nlink(),
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                metadata.mtime(),
                metadata.mtime_nsec(),
            ),
        })
    }

    fn running(&self, pid: i32) -> Option<(bool, Option<String>)> {
        let running = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        Some((
            running.isTerminated(),
            running.bundleIdentifier().map(|id| id.to_string()),
        ))
    }
}

/// What a check of the pinned player found. A transient failure is a read
/// that could not be completed for the same verified process, such as a
/// missing NSRunningApplication entry during an application switch. A
/// definitive one means the pinned process is gone or was replaced. Each
/// names the check, for the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Check {
    Current,
    Transient(&'static str),
    Gone(&'static str),
}

fn missing(why: Missing) -> Check {
    match why {
        Missing::Gone => Check::Gone("process_gone"),
        Missing::OtherOwner => Check::Gone("process_owner"),
        Missing::Unreadable => Check::Transient("process_info"),
    }
}

fn admit(reads: &impl Reads, pid: i32) -> Option<Process> {
    if pid <= 0 {
        return None;
    }
    let before = reads.info(pid).ok()?;
    if before.uid != reads.uid() {
        return None;
    }
    let raw = reads.path(pid)?;
    let executable = reads.canonical(&raw)?;
    if raw != executable {
        return None;
    }
    let file = reads.file(&executable)?;
    if !file.regular || file.links != 1 {
        return None;
    }
    let (terminated, bundle) = reads.running(pid)?;
    if terminated || bundle.as_deref() != Some(BUNDLE) {
        return None;
    }
    if reads.info(pid).ok()? != before {
        return None;
    }
    Some(Process {
        pid,
        seconds: before.seconds,
        micros: before.micros,
        executable,
        file: file.identity,
    })
}

/// Checks the pinned process. Everything that can show a replacement (the
/// owner, the start time, the executable's path, canonical form, link count
/// and file identity) is compared with the pin first and is definitive.
/// Only after the process is verified as the pinned one can a failed read
/// be transient.
fn check_pin_with(reads: &impl Reads, pin: &Process) -> Check {
    if pin.pid <= 0 {
        return Check::Gone("pid");
    }
    let before = match reads.info(pin.pid) {
        Ok(info) => info,
        Err(why) => return missing(why),
    };
    if before.uid != reads.uid() {
        return Check::Gone("process_owner");
    }
    if before.seconds != pin.seconds || before.micros != pin.micros {
        return Check::Gone("start_time");
    }
    let Some(raw) = reads.path(pin.pid) else {
        return Check::Transient("process_path");
    };
    if raw.as_os_str() != pin.executable.as_os_str() {
        return Check::Gone("executable_path");
    }
    match reads.canonical(&raw) {
        None => return Check::Transient("canonical_path"),
        Some(canonical) if canonical != raw => return Check::Gone("canonical_path"),
        Some(_) => {}
    }
    match reads.file(&raw) {
        None => return Check::Transient("executable_metadata"),
        Some(file) if !file.regular || file.links != 1 => {
            return Check::Gone("executable_metadata")
        }
        Some(file) if file.identity != pin.file => return Check::Gone("executable_file"),
        Some(_) => {}
    }
    match reads.running(pin.pid) {
        None => return Check::Transient("running_application"),
        Some((true, _)) => return Check::Transient("terminated"),
        Some((false, None)) => return Check::Transient("bundle_identifier"),
        Some((false, Some(bundle))) if bundle != BUNDLE => return Check::Gone("bundle_identifier"),
        Some(_) => {}
    }
    // The start time again, so a process replaced during the reads is caught.
    match reads.info(pin.pid) {
        Ok(after) if after == before => Check::Current,
        Ok(_) => Check::Gone("start_time"),
        Err(why) => missing(why),
    }
}

fn check_pin(pin: &Process) -> Check {
    check_pin_with(&System, pin)
}

fn same_admission(expected: &Process, actual: &Process) -> bool {
    expected.pid == actual.pid
        && expected.seconds == actual.seconds
        && expected.micros == actual.micros
        && expected.executable.as_os_str() == actual.executable.as_os_str()
}

pub(crate) fn initialize(
    source: Option<&crate::application_audio_host::DevSettings>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(), &'static str> {
    initialize_with(source, lookup, &System)
}

// Shared setup path: only the operating-system reads are substituted in tests.
fn initialize_with(
    source: Option<&crate::application_audio_host::DevSettings>,
    lookup: impl Fn(&str) -> Option<String>,
    reads: &impl Reads,
) -> Result<(), &'static str> {
    let pin = expected(source.map(|settings| settings.application.as_str()), lookup)?
        .map(|wanted| {
            let actual = admit(reads, wanted.pid).ok_or("owned player unavailable")?;
            if !same_admission(&wanted, &actual) {
                return Err("owned player identity changed");
            }
            Ok(Pin(actual))
        })
        .transpose()?;
    PIN.set(pin)
        .map_err(|_| "owned player settings already frozen")
}

pub(crate) fn supports(name: &str) -> bool {
    supported_kind(
        Kind::from_name(name),
        PIN.get().and_then(Option::as_ref).is_some(),
    )
}

fn supported_kind(kind: Option<Kind>, owned: bool) -> bool {
    matches!(
        (kind, owned),
        (Some(Kind::QuickTime), false) | (Some(Kind::OwnedPlayer), true)
    )
}

/// Whether the pinned player is still the admitted process, if one is
/// pinned. Every check must pass; see `check` for the reason when not.
pub(crate) fn current() -> bool {
    check() == Check::Current
}

/// The pinned player's state now, naming a failed check.
pub(crate) fn check() -> Check {
    match PIN.get().and_then(Option::as_ref) {
        None => Check::Current,
        Some(pin) => check_pin(&pin.0),
    }
}

/// `selection` naming its failed check. The selection's own fields never
/// change, so a mismatch there is definitive.
pub(crate) fn selection_check(pid: i32, bundle: &str, name: &str, helpers: usize) -> Check {
    let Some(pin) = PIN.get().and_then(Option::as_ref) else {
        return if name != PLAYER {
            Check::Current
        } else {
            Check::Gone("selection")
        };
    };
    if !selection_matches(&pin.0, pid, bundle, name, helpers) {
        return Check::Gone("selection");
    }
    check_pin(&pin.0)
}
fn selection_matches(pin: &Process, pid: i32, bundle: &str, name: &str, helpers: usize) -> bool {
    pid == pin.pid && bundle == BUNDLE && name == PLAYER && helpers == 0
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn values(key: &str) -> Option<String> {
        Some(
            match key {
                "TALKQTE_DEV_APPLICATION_SOURCE" => PLAYER,
                "TALKQTE_DEV_STOP_SIGNAL" => "usr2",
                "TALKQTE_DEV_PLAYER_PID" => "123",
                "TALKQTE_DEV_PLAYER_START_SEC" => "123456",
                "TALKQTE_DEV_PLAYER_START_USEC" => "0",
                "TALKQTE_DEV_PLAYER_EXECUTABLE" => "/fictional/Player.app/Contents/MacOS/Player",
                _ => return None,
            }
            .into(),
        )
    }
    /// A fictional process table: the pinned player as it was admitted,
    /// changed field by field to stand in for a replacement or a read that
    /// briefly fails.
    #[derive(Clone)]
    struct Fake {
        info: Result<Info, Missing>,
        /// What the second process-table read returns, if it differs.
        second_info: Option<Result<Info, Missing>>,
        reads: std::cell::Cell<u32>,
        path: Option<PathBuf>,
        canonical: Option<PathBuf>,
        file: Option<FileInfo>,
        running: Option<(bool, Option<String>)>,
    }

    const EXE: &str = "/fictional/Player.app/Contents/MacOS/Player";

    impl Fake {
        fn admitted() -> Self {
            Self {
                info: Ok(Info {
                    uid: 501,
                    seconds: 1_000,
                    micros: 5,
                }),
                second_info: None,
                reads: std::cell::Cell::new(0),
                path: Some(EXE.into()),
                canonical: Some(EXE.into()),
                file: Some(FileInfo {
                    regular: true,
                    links: 1,
                    identity: (1, 2, 3, 4, 5),
                }),
                running: Some((false, Some(BUNDLE.into()))),
            }
        }
    }

    impl Reads for Fake {
        fn uid(&self) -> u32 {
            501
        }
        fn info(&self, _: i32) -> Result<Info, Missing> {
            let read = self.reads.get() + 1;
            self.reads.set(read);
            match self.second_info {
                Some(second) if read >= 2 => second,
                _ => self.info,
            }
        }
        fn path(&self, _: i32) -> Option<PathBuf> {
            self.path.clone()
        }
        fn canonical(&self, _: &std::path::Path) -> Option<PathBuf> {
            self.canonical.clone()
        }
        fn file(&self, _: &std::path::Path) -> Option<FileInfo> {
            self.file
        }
        fn running(&self, _: i32) -> Option<(bool, Option<String>)> {
            self.running.clone()
        }
    }

    /// Used only in an isolated child: freeze through the production setup path.
    pub(crate) fn freeze_launcher_fixture(
        source: Option<&crate::application_audio_host::DevSettings>,
    ) {
        let lookup = |key: &str| match key {
            "TALKQTE_DEV_PLAYER_START_SEC" => Some("1000".into()),
            "TALKQTE_DEV_PLAYER_START_USEC" => Some("5".into()),
            "TALKQTE_DEV_PLAYER_EXECUTABLE" => Some(EXE.into()),
            _ => values(key),
        };
        // Failures must not freeze a partial identity or make the owned name eligible.
        for field in FIELDS.into_iter().chain(["TALKQTE_DEV_STOP_SIGNAL"]) {
            assert!(initialize_with(
                source,
                |key| if key == field { None } else { lookup(key) },
                &Fake::admitted()
            )
            .is_err());
            assert!(!supports(PLAYER));
        }
        for bad in [
            Fake {
                running: Some((false, Some("com.example.other".into()))),
                ..Fake::admitted()
            },
            Fake {
                info: Ok(Info {
                    uid: 502,
                    seconds: 1000,
                    micros: 5,
                }),
                ..Fake::admitted()
            },
            Fake {
                second_info: Some(Ok(Info {
                    uid: 501,
                    seconds: 1001,
                    micros: 5,
                })),
                ..Fake::admitted()
            },
            Fake {
                path: Some("/fictional/Other".into()),
                ..Fake::admitted()
            },
        ] {
            assert!(initialize_with(source, lookup, &bad).is_err());
            assert!(!supports(PLAYER));
        }
        initialize_with(source, lookup, &Fake::admitted()).unwrap();
        assert!(supports(PLAYER));
        assert!(!supports("QuickTime Player"));
        assert!(initialize_with(source, lookup, &Fake::admitted()).is_err());
    }

    #[test]
    fn a_replaced_player_is_definitive_even_when_a_transient_read_also_fails() {
        let pin = admit(&Fake::admitted(), 123).unwrap();
        assert_eq!(check_pin_with(&Fake::admitted(), &pin), Check::Current);
        let check = |change: fn(&mut Fake)| {
            let mut fake = Fake::admitted();
            change(&mut fake);
            check_pin_with(&fake, &pin)
        };
        // (a) The pid now belongs to another user's process.
        assert_eq!(
            check(|f| f.info = Err(Missing::OtherOwner)),
            Check::Gone("process_owner")
        );
        assert_eq!(
            check(|f| f.info = Err(Missing::Gone)),
            Check::Gone("process_gone")
        );
        // (b) The pid was reused by this user's process with a new start time,
        // and the running-application lookup also fails.
        assert_eq!(
            check(|f| {
                f.info = Ok(Info {
                    uid: 501,
                    seconds: 2_000,
                    micros: 0,
                });
                f.running = None;
            }),
            Check::Gone("start_time")
        );
        // (c) The player exec()ed another binary: same pid and start time,
        // another path, and its bundle identifier is gone too.
        assert_eq!(
            check(|f| {
                f.path = Some("/fictional/Other.app/Contents/MacOS/Other".into());
                f.running = Some((false, None));
            }),
            Check::Gone("executable_path")
        );
        // (d) Tamper signals: the path now resolves elsewhere, or the file has
        // gained a link, or it was rewritten.
        assert_eq!(
            check(|f| f.canonical = Some("/fictional/elsewhere/Player".into())),
            Check::Gone("canonical_path")
        );
        assert_eq!(
            check(|f| f.file = Some(FileInfo {
                links: 2,
                ..f.file.unwrap()
            })),
            Check::Gone("executable_metadata")
        );
        assert_eq!(
            check(|f| f.file = Some(FileInfo {
                identity: (1, 2, 3, 4, 6),
                ..f.file.unwrap()
            })),
            Check::Gone("executable_file")
        );
        assert_eq!(
            check(|f| f.running = Some((false, Some("com.example.other".into())))),
            Check::Gone("bundle_identifier")
        );
        // Only reads that could not complete for the verified process are
        // transient.
        assert_eq!(
            check(|f| f.info = Err(Missing::Unreadable)),
            Check::Transient("process_info")
        );
        assert_eq!(check(|f| f.path = None), Check::Transient("process_path"));
        assert_eq!(
            check(|f| f.canonical = None),
            Check::Transient("canonical_path")
        );
        assert_eq!(
            check(|f| f.file = None),
            Check::Transient("executable_metadata")
        );
        assert_eq!(
            check(|f| f.running = None),
            Check::Transient("running_application")
        );
        assert_eq!(
            check(|f| f.running = Some((true, Some(BUNDLE.into())))),
            Check::Transient("terminated")
        );
        assert_eq!(
            check(|f| f.running = Some((false, None))),
            Check::Transient("bundle_identifier")
        );
        // The process is replaced during the reads: everything else matches,
        // but the closing read of the process table shows a new start time.
        let replaced_during = Fake {
            second_info: Some(Ok(Info {
                uid: 501,
                seconds: 1_000,
                micros: 6,
            })),
            ..Fake::admitted()
        };
        assert_eq!(
            check_pin_with(&replaced_during, &pin),
            Check::Gone("start_time")
        );
        assert_eq!(
            replaced_during.reads.get(),
            2,
            "the start time is read twice"
        );
        let gone_during = Fake {
            second_info: Some(Err(Missing::Gone)),
            ..Fake::admitted()
        };
        assert_eq!(
            check_pin_with(&gone_during, &pin),
            Check::Gone("process_gone")
        );
        // A pid that is not a process at all is gone.
        let no_pid = Process { pid: 0, ..pin };
        assert_eq!(
            check_pin_with(&Fake::admitted(), &no_pid),
            Check::Gone("pid")
        );
    }

    #[test]
    fn explicit_fixed_player_requires_complete_canonical_identity_and_stop() {
        let pin = expected(Some(PLAYER), values).unwrap().unwrap();
        assert_eq!(pin.pid, 123);
        assert_eq!(pin.micros, 0);
        for field in FIELDS.into_iter().chain(["TALKQTE_DEV_STOP_SIGNAL"]) {
            assert!(expected(Some(PLAYER), |key| if key == field {
                None
            } else {
                values(key)
            })
            .is_err());
        }
        for (field, bad) in [
            (FIELDS[0], "0"),
            (FIELDS[0], "2147483648"),
            (FIELDS[0], "0123"),
            (FIELDS[1], "0"),
            (FIELDS[1], "18446744073709551616"),
            (FIELDS[2], "1000000"),
            (FIELDS[2], "00"),
            (FIELDS[3], "relative"),
            (FIELDS[3], "/fictional/../Player"),
        ] {
            assert!(expected(Some(PLAYER), |key| if key == field {
                Some(bad.into())
            } else {
                values(key)
            })
            .is_err());
        }
        assert!(expected(Some("QuickTime Player"), values).is_err());
        // Source identity is already frozen, so environment rereads cannot
        // select a different source between arming and autostart.
        assert_eq!(
            expected(Some(PLAYER), |key| {
                if key == "TALKQTE_DEV_APPLICATION_SOURCE" {
                    panic!("source reread")
                } else {
                    values(key)
                }
            })
            .unwrap()
            .unwrap(),
            pin
        );
        assert_eq!(expected(None, |_| None).unwrap(), None);
    }
    #[test]
    fn reused_pid_replacement_executable_or_start_never_reacquires() {
        let pin = expected(Some(PLAYER), values).unwrap().unwrap();
        for mutate in [0, 1, 2, 3] {
            let mut changed = pin.clone();
            match mutate {
                0 => changed.pid += 1,
                1 => changed.seconds += 1,
                2 => changed.micros += 1,
                _ => changed.executable = "/fictional/other".into(),
            }
            assert!(!same_admission(&pin, &changed));
        }
        let mut replaced = pin.clone();
        replaced.file.1 += 1;
        assert_ne!(pin, replaced);
    }
    #[test]
    fn only_the_frozen_source_kind_is_supported_and_legacy_remains_separate() {
        assert!(supported_kind(Kind::from_name("QuickTime Player"), false));
        assert!(!supported_kind(Kind::from_name(PLAYER), false));
        assert!(supported_kind(Kind::from_name(PLAYER), true));
        assert!(!supported_kind(Kind::from_name("QuickTime Player"), true));
        for owned in [false, true] {
            assert!(!supported_kind(
                Kind::from_name("TalkQTE Lab Player Helper"),
                owned
            ));
            assert!(!supported_kind(Kind::from_name("Other Player"), owned));
        }
    }

    #[test]
    fn selection_is_exact_main_process_never_name_prefix_or_helpers() {
        let pin = expected(Some(PLAYER), values).unwrap().unwrap();
        assert!(selection_matches(&pin, pin.pid, BUNDLE, PLAYER, 0));
        for (pid, bundle, name, helpers) in [
            (124, BUNDLE, PLAYER, 0),
            (123, "com.talkqte.lab-player.helper", PLAYER, 0),
            (123, BUNDLE, "QuickTime Player", 0),
            (123, BUNDLE, PLAYER, 1),
        ] {
            assert!(!selection_matches(&pin, pid, bundle, name, helpers));
        }
    }
}
