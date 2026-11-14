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

fn process(pid: i32) -> Option<Process> {
    if pid <= 0 {
        return None;
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
        (usize::try_from(copied).ok()? == size
            && value.pbi_pid == pid as u32
            && value.pbi_uid == libc::getuid())
        .then_some(value)
    };
    let before = info()?;
    let mut path = [0u8; 4096];
    // SAFETY: proc_pidpath writes at most the supplied buffer length.
    let copied = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if copied <= 0 {
        return None;
    }
    let end = path.iter().position(|b| *b == 0)?;
    let raw = PathBuf::from(std::str::from_utf8(&path[..end]).ok()?);
    let executable = raw.canonicalize().ok()?;
    if raw.as_os_str() != executable.as_os_str() {
        return None;
    }
    let metadata = std::fs::symlink_metadata(&executable).ok()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return None;
    }
    let running = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    if running.isTerminated() || running.bundleIdentifier()?.to_string() != BUNDLE {
        return None;
    }
    let after = info()?;
    if before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec
    {
        return None;
    }
    Some(Process {
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

pub(crate) fn current() -> bool {
    PIN.get()
        .and_then(Option::as_ref)
        .is_none_or(|pin| process(pin.0.pid).as_ref() == Some(&pin.0))
}

pub(crate) fn selection(pid: i32, bundle: &str, name: &str, helpers: usize) -> bool {
    let Some(pin) = PIN.get().and_then(Option::as_ref) else {
        return name != PLAYER;
    };
    selection_matches(&pin.0, pid, bundle, name, helpers) && current()
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
