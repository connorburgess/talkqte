//! Writes the reviewed export to the destination the person chose. The text
//! is written whole or not at all: to a temporary file beside the
//! destination, flushed to disk, then renamed over it. A full disk or a
//! failed write leaves no partial file and never truncates a file being
//! replaced, and the export stays in memory for another try.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const UNWRITABLE: &str = "Could not save the file. Choose a writable destination.";
pub const FULL: &str =
    "There is not enough space to save the file. Free some space or choose another disk; nothing was saved and the export is still here.";

/// Writes `text` to `path` atomically, with a fixed message on failure.
pub fn write(path: &Path, text: &str) -> Result<(), &'static str> {
    let temp = temporary(path).ok_or(UNWRITABLE)?;
    let result = write_then_rename(&temp, path, text.as_bytes());
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(message(&error));
    }
    Ok(())
}

fn temporary(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty());
    let temp = format!(".{name}.talkqte-{}.tmp", std::process::id());
    Some(dir.map_or_else(|| PathBuf::from(&temp), |dir| dir.join(&temp)))
}

fn write_then_rename(temp: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temp, path)
}

/// A full disk or quota is said as such; anything else is the destination.
fn message(error: &io::Error) -> &'static str {
    // ENOSPC and EDQUOT on macOS and Linux.
    let full = matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    ) || matches!(error.raw_os_error(), Some(28 | 69 | 122));
    if full {
        FULL
    } else {
        UNWRITABLE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("talkqte-export-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn a_new_file_and_a_replaced_file_get_the_whole_export_and_no_temporary_is_left() {
        let dir = scratch("replace");
        let path = dir.join("talkqte-notes.md");
        write(&path, "# Fictional notes\n\nFirst version.\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# Fictional notes\n\nFirst version.\n"
        );
        write(&path, "# Fictional notes\n\nSecond.\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# Fictional notes\n\nSecond.\n"
        );
        assert!(leftovers(&dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_leaves_the_existing_file_untouched_and_nothing_partial() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("readonly");
        let path = dir.join("talkqte-notes.md");
        std::fs::write(&path, "Earlier fictional export.\n").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = write(&path, "A newer fictional export.\n");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result, Err(UNWRITABLE));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "Earlier fictional export.\n"
        );
        assert!(leftovers(&dir).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_full_disk_is_said_plainly_and_other_failures_name_the_destination() {
        for code in [28, 69] {
            assert_eq!(message(&io::Error::from_raw_os_error(code)), FULL);
        }
        assert_eq!(message(&io::Error::from(io::ErrorKind::StorageFull)), FULL);
        assert_eq!(
            message(&io::Error::from(io::ErrorKind::PermissionDenied)),
            UNWRITABLE
        );
        assert!(FULL.contains("nothing was saved"));
    }
}
