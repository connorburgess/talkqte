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

/// What a check of the pinned player found. A transient failure is a read
/// that could not be completed or a property that may briefly be missing,
/// such as during an application switch; a definitive one means the pinned
/// process is gone or was replaced. Each names the check, for the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Check {
    Current,
    Transient(&'static str),
    Gone(&'static str),
}

fn process(pid: i32) -> Option<Process> {
    read_process(pid).ok()
}

/// Reads the process's identity, or names the check that failed and whether
/// that failure is definitive (`Err((check, true))`).
fn read_process(pid: i32) -> Result<Process, (&'static str, bool)> {
    if pid <= 0 {
        return Err(("pid", true));
    }
    // SAFETY: fixed-size owned buffers, exact returned struct length checked.
    let info = || unsafe {
        let mut value: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of_val(&value);
        let copied = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut value as *mut libc::proc_bsdinfo).cast(),
            i32::try_from(size).ok()?,
        );
        (usize::try_from(copied).ok()? == size && value.pbi_pid == pid as u32).then_some(value)
    };
    let gone = || {
        // SAFETY: signal 0 only checks that the process exists.
        let signalled = unsafe { libc::kill(pid, 0) };
        signalled != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    };
    let Some(before) = info() else {
        return Err(if gone() {
            ("process_gone", true)
        } else {
            ("process_info", false)
        });
    };
    // SAFETY: getuid has no arguments or side effects.
    if before.pbi_uid != unsafe { libc::getuid() } {
        return Err(("process_owner", true));
    }
    let mut path = [0u8; 4096];
    // SAFETY: proc_pidpath writes at most the supplied buffer length.
    let copied = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if copied <= 0 {
        return Err(("process_path", false));
    }
    let end = path
        .iter()
        .position(|b| *b == 0)
        .ok_or(("process_path", false))?;
    let raw =
        PathBuf::from(std::str::from_utf8(&path[..end]).map_err(|_| ("process_path", false))?);
    let executable = raw.canonicalize().map_err(|_| ("canonical_path", false))?;
    if raw.as_os_str() != executable.as_os_str() {
        return Err(("canonical_path", false));
    }
    let metadata =
        std::fs::symlink_metadata(&executable).map_err(|_| ("executable_metadata", false))?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(("executable_metadata", false));
    }
    let running = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or(("running_application", false))?;
    if running.isTerminated() {
        return Err(("terminated", false));
    }
    if running
        .bundleIdentifier()
        .map(|id| id.to_string())
        .as_deref()
        != Some(BUNDLE)
    {
        return Err(("bundle_identifier", false));
    }
    let after = info().ok_or(if gone() {
        ("process_gone", true)
    } else {
        ("process_info", false)
    })?;
    if before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec
    {
        return Err(("start_time", true));
    }
    Ok(Process {
        pid,
        seconds: before.pbi_start_tvsec,
        micros: before.pbi_start_tvusec,
        executable,
        file: (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
        ),
    })
}

/// Compares a fresh read with the pin, naming the first difference. Every
/// difference is definitive: the pinned process was replaced.
fn compare(pin: &Process, actual: &Process) -> Check {
    if actual.pid != pin.pid || actual.seconds != pin.seconds || actual.micros != pin.micros {
        Check::Gone("start_time")
    } else if actual.executable.as_os_str() != pin.executable.as_os_str() {
        Check::Gone("executable_path")
    } else if actual.file != pin.file {
        Check::Gone("executable_file")
    } else {
        Check::Current
    }
}

fn check_pin(pin: &Process) -> Check {
    match read_process(pin.pid) {
        Ok(actual) => compare(pin, &actual),
        Err((name, true)) => Check::Gone(name),
        Err((name, false)) => Check::Transient(name),
    }
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
    let pin = expected(source.map(|settings| settings.application.as_str()), lookup)?
        .map(|wanted| {
            let actual = process(wanted.pid).ok_or("owned player unavailable")?;
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
mod tests {
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
    #[test]
    fn a_replaced_player_is_definitive_and_names_what_changed() {
        let pin = Process {
            pid: 123,
            seconds: 1_000,
            micros: 5,
            executable: "/fictional/Player.app/Contents/MacOS/Player".into(),
            file: (1, 2, 3, 4, 5),
        };
        assert_eq!(compare(&pin, &pin.clone()), Check::Current);
        let restarted = Process {
            micros: 6,
            ..pin.clone()
        };
        assert_eq!(compare(&pin, &restarted), Check::Gone("start_time"));
        let moved = Process {
            executable: "/fictional/Other.app/Contents/MacOS/Player".into(),
            ..pin.clone()
        };
        assert_eq!(compare(&pin, &moved), Check::Gone("executable_path"));
        let rebuilt = Process {
            file: (1, 2, 3, 4, 6),
            ..pin.clone()
        };
        assert_eq!(compare(&pin, &rebuilt), Check::Gone("executable_file"));
        // A pid that is not a process at all is gone, not a transient read.
        assert_eq!(read_process(0).err(), Some(("pid", true)));
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
