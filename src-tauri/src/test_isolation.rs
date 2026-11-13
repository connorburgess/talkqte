//! Runs one ignored test of this binary in a child process whose home,
//! app-data and temporary folders, and working directory, all point at one
//! empty folder, so a test can show what that code wrote and printed.
//! Folders are redirected through environment variables: a write to an
//! unrelated absolute path would go unnoticed.

use std::ffi::OsString;

/// What the child process left behind and printed.
pub(crate) struct Isolated {
    /// Entries left in the redirected folder.
    pub left: Vec<OsString>,
    /// Everything written to stdout and stderr.
    pub printed: String,
}

/// Runs the ignored test at `path` (for example `live::tests::name`) with
/// `variables` added to its environment and `without` removed, and fails
/// unless exactly that test ran and passed.
pub(crate) fn run(path: &str, variables: &[(&str, &str)], without: &[&str]) -> Isolated {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let folder = std::env::temp_dir().join(format!(
        "talkqte-isolated-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            path,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .current_dir(&folder);
    // Wherever the app or a library would keep data, a cache or a temporary
    // file on macOS, Windows or Linux.
    for name in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TMPDIR",
        "TEMP",
        "TMP",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
    ] {
        child.env(name, &folder);
    }
    for name in without {
        child.env_remove(name);
    }
    for (name, value) in variables {
        child.env(name, value);
    }
    let output = child.output().unwrap();
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let left = std::fs::read_dir(&folder)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    let _ = std::fs::remove_dir_all(&folder);
    assert!(
        output.status.success() && printed.contains("1 passed"),
        "{path} did not run: {printed}"
    );
    Isolated { left, printed }
}
