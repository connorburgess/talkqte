//! Immutable public build identity. No runtime inspection of user data.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: &'static str,
    pub commit: &'static str,
    pub dirty: Option<bool>,
    pub profile: &'static str,
    pub target: &'static str,
    pub source_date_epoch: Option<u64>,
}

#[tauri::command]
pub fn build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("TALKQTE_BUILD_COMMIT"),
        dirty: match env!("TALKQTE_BUILD_DIRTY") {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        profile: env!("TALKQTE_BUILD_PROFILE"),
        target: env!("TALKQTE_BUILD_TARGET"),
        source_date_epoch: env!("TALKQTE_BUILD_EPOCH").parse().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_identity_is_bounded_public_metadata_only() {
        let info = build_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(
            info.commit == "unknown"
                || (info.commit.len() == 40 && info.commit.bytes().all(|b| b.is_ascii_hexdigit()))
        );
        for label in [info.profile, info.target] {
            assert!(!label.is_empty() && label.len() <= 100);
            assert!(label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)));
        }
        let value = serde_json::to_value(info).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert!(value.get("sourceDateEpoch").is_some());
    }
}

#[cfg(test)]
#[path = "../build_metadata.rs"]
mod build_metadata;
