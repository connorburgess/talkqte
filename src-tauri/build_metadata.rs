//! Build-time provenance only. No runtime filesystem or network access.
#[cfg(not(test))]
use std::{env, path::Path, process::Command};

#[cfg(not(test))]
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn commit(value: Option<&str>) -> String {
    value
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "unknown".into())
}

pub fn label(value: Option<&str>) -> String {
    value
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 100
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .unwrap_or("unknown")
        .into()
}

pub fn epoch(value: Option<&str>) -> String {
    value
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s <= 253_402_300_799)
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(not(test))]
pub fn emit() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory");
    let root = Path::new(&manifest).parent().expect("repository parent");
    let head = git(root, &["rev-parse", "HEAD"]);
    let source = commit(
        head.as_deref()
            .or(env::var("TALKQTE_COMMIT").ok().as_deref()),
    );
    let dirty = git(root, &["status", "--porcelain", "--untracked-files=normal"])
        .map(|s| if s.is_empty() { "false" } else { "true" })
        .unwrap_or("unknown");
    println!("cargo:rustc-env=TALKQTE_BUILD_COMMIT={source}");
    println!("cargo:rustc-env=TALKQTE_BUILD_DIRTY={dirty}");
    for (input, output) in [
        ("PROFILE", "TALKQTE_BUILD_PROFILE"),
        ("TARGET", "TALKQTE_BUILD_TARGET"),
    ] {
        println!(
            "cargo:rustc-env={output}={}",
            label(env::var(input).ok().as_deref())
        );
    }
    println!(
        "cargo:rustc-env=TALKQTE_BUILD_EPOCH={}",
        epoch(env::var("SOURCE_DATE_EPOCH").ok().as_deref())
    );
    for name in ["TALKQTE_COMMIT", "SOURCE_DATE_EPOCH"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    // Worktrees use a .git file; resolve administrative paths through Git.
    for name in ["HEAD", "index", "packed-refs"] {
        if let Some(path) = git(root, &["rev-parse", "--git-path", name]) {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    if let Some(reference) = git(root, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git(root, &["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    if let Some(files) = git(root, &["ls-files"]) {
        for path in files.lines() {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_untrusted_inputs_never_become_public_paths_or_environment_text() {
        assert_eq!(commit(None), "unknown");
        assert_eq!(commit(Some("/fictional/source/path")), "unknown");
        assert_eq!(commit(Some(&"A".repeat(40))), "a".repeat(40));
        assert_eq!(label(Some("/fictional/profile")), "unknown");
        assert_eq!(
            label(Some("debug\ncargo:rustc-env=PRIVATE=value")),
            "unknown"
        );
        assert_eq!(label(Some("aarch64-apple-darwin")), "aarch64-apple-darwin");
        assert_eq!(label(Some(&"a".repeat(101))), "unknown");
        assert_eq!(epoch(None), "unknown");
        assert_eq!(epoch(Some("-1")), "unknown");
        assert_eq!(epoch(Some("253402300800")), "unknown");
        assert_eq!(epoch(Some("0")), "0");
    }
}
