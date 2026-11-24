//! What this build can do on the platform it was built for, for the notebook
//! to say truthfully. Each answer is fixed at build time from the adapters
//! this platform has; nothing here queries a device, a permission or the
//! network. See docs/platforms.md for the evidence behind each platform.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Macos,
    Windows,
    Linux,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub os: Os,
    /// The microphone check and microphone-only live sessions have a capture
    /// adapter here (Core Audio on macOS, WASAPI on Windows, ALSA on Linux).
    pub microphone: bool,
    /// Another application's audio (ScreenCaptureKit): macOS only so far.
    pub application_audio: bool,
    /// The "a call seems to be starting" offer: macOS only so far.
    pub call_prompt: bool,
    /// The companion follows the person over full-screen apps on every
    /// Space: macOS only so far. Elsewhere it is an always-on-top window
    /// whose stacking depends on the window manager.
    pub companion_over_full_screen: bool,
}

pub const fn capabilities() -> Capabilities {
    let os = if cfg!(target_os = "macos") {
        Os::Macos
    } else if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "linux") {
        Os::Linux
    } else {
        Os::Other
    };
    let macos = matches!(os, Os::Macos);
    Capabilities {
        os,
        microphone: !matches!(os, Os::Other),
        application_audio: macos,
        call_prompt: macos,
        companion_over_full_screen: macos,
    }
}

#[tauri::command]
pub fn platform_capabilities() -> Capabilities {
    capabilities()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The notebook's claims follow the adapters compiled in: application
    /// audio and the call prompt exist only where their macOS adapters do.
    #[test]
    fn capabilities_match_the_adapters_built_for_this_platform() {
        let caps = capabilities();
        assert_eq!(caps.application_audio, cfg!(target_os = "macos"));
        assert_eq!(caps.call_prompt, cfg!(target_os = "macos"));
        assert_eq!(
            caps.microphone,
            cfg!(any(target_os = "macos", windows, target_os = "linux"))
        );
        let json = serde_json::to_value(caps).unwrap();
        assert!(json.get("applicationAudio").is_some());
        assert!(json.get("companionOverFullScreen").is_some());
        #[cfg(windows)]
        assert_eq!(json["os"], "windows");
        #[cfg(target_os = "linux")]
        assert_eq!(json["os"], "linux");
        #[cfg(target_os = "macos")]
        assert_eq!(json["os"], "macos");
    }
}
