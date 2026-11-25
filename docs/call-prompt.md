# Call-starting prompt

24 November 2026. A first slice of "offer to start when a call starts". It
has run only against scripted signals and fixtures; nothing here was read
from a real microphone or application.

## What it does

When the person has turned it on (**Settings → When a call starts**), TalkQTE
reads local metadata every 500 ms while it is open:

- whether another process has a microphone running (using Core Audio's Process
  Object List on macOS 14.2+ to identify background call apps too, falling back
  to the default input device's "running somewhere" property on macOS 14.0–14.1
  or when unavailable),
- whether a camera device is active (CoreMediaIO's "device is running somewhere"
  metadata, catching instant meeting preview screens even while the microphone
  is muted), and
- which application is frontmost.

TalkQTE ignores its own process identifier and bundle identifiers
(`app.talkqte.*` and `com.talkqte.*`). After 1.5 seconds when a known meeting
application or browser is identified (or 3 seconds for generic microphone-only
use), with no TalkQTE live session starting or running and no microphone check
on, the companion shows one small offer: "A call seems to be starting in Zoom."
with **Start session…**, **Not for Zoom**, **Don't ask again** and **Not now**.
It goes away by itself after 45 seconds or when the microphone and camera stop,
and appears once per spell of call activity. After **Not now**, or an offer left
to go away, the same application is not offered again for 20 minutes, so a call
in which the microphone briefly stops (a mute, a device change) is asked about
once. The companion never takes focus, and a companion the person hid stays
hidden.

**Start session…** brings the notebook forward with **Listen to** set to the
microphone and, for a meeting application, that application, matched in the
list by its bundle identifier, not its name. For a browser it sets the
microphone only: a browser's audio would include every tab, so the person
adds it deliberately if they want it. Nothing is listed, captured or sent: the
person still lists applications (the application is chosen when it appears),
presses Start live session and approves cue processing, as always. TalkQTE
never starts a session by itself.

Not for *App* skips that application; Don't ask again turns the prompt off.
Both, and the setting itself, are kept in the [settings file](../PRIVACY.md)
and apply at the next launch. Not for *App* is kept as the application's
bundle identifier only, and only for the known meeting applications and
browsers below, which Settings names from a fixed list after a restart. The
setting is **off by default**.

## Signals assessed

| Signal | Needs | Used |
| --- | --- | --- |
| Active audio input processes (`kAudioHardwarePropertyProcessObjectList`, `kAudioProcessPropertyIsRunningInput`, `kAudioProcessPropertyPID`, `kAudioProcessPropertyBundleID`, Core Audio on macOS 14.2+) | No permission, no entitlement; metadata-only process list excluding TalkQTE itself. | Yes: identifies which app holds the microphone even in the background. |
| Default input device "running somewhere" (`kAudioDevicePropertyDeviceIsRunningSomewhere`, Core Audio) | No permission, no entitlement; a property read that opens nothing. | Yes: fallback trigger on macOS 14.0–14.1 or when the process list is unavailable. |
| Camera device "running somewhere" (`kCMIOHardwarePropertyDevices`, `kCMIODevicePropertyDeviceIsRunningSomewhere`, CoreMediaIO) | No camera permission, no entitlement; metadata-only device check. | Yes: catches instant meeting preview screens with a known meeting app or browser even when muted. |
| Frontmost application (`NSWorkspace.frontmostApplication`: name and bundle identifier) | No permission. | Yes: identifies camera previews, fallback mic detection, and system-daemon apps like FaceTime or Safari. |
| A known meeting application launching or coming to the front | No permission. | No: opening Zoom or Teams is not a call, so on its own it would prompt too often. It only names the application when the microphone or camera is in use. |
| Which browser tab holds a call (Google Meet) | Window titles need Screen Recording or Accessibility; tab URLs need Automation or an extension. | No. A browser in front is offered as "a call?", with the warning that a browser's audio may not be heard yet ([browser diagnostic](native-application-audio-host.md#selected-browser-diagnostic--14-november-2026)). |
| A calendar meeting about to start (EventKit) | Calendar access (`NSCalendarsFullAccessUsageDescription`, a macOS prompt). | No: a later, opt-in step. |

Known meeting applications, by bundle identifier: Zoom (`us.zoom.xos`),
Microsoft Teams (`com.microsoft.teams2`, `com.microsoft.teams`), FaceTime
(`com.apple.FaceTime`), Webex (`com.cisco.webexmeetingsapp`,
`Cisco-Systems.Spark`), Slack (`com.tinyspeck.slackmacgap`), Discord
(`com.hnc.Discord`), WhatsApp (`net.whatsapp.WhatsApp`), Telegram
(`ru.keepcoder.Telegram`), Signal (`org.whispersystems.signal-desktop`), Tuple
(`app.tuple.app`), Amazon Chime (`com.amazon.Amazon-Chime`), RingCentral
(`com.ringcentral.glip`), GoTo (`com.logmein.goto`), Around
(`co.around.Around`), and Loom (`com.loom.desktop`).
Browsers: Chrome (`com.google.Chrome`), Safari (`com.apple.Safari`), Arc
(`company.thebrowser.Browser`), Firefox (`org.mozilla.firefox`), Edge
(`com.microsoft.edgemac`), Brave (`com.brave.Browser`), Vivaldi
(`com.vivaldi.Vivaldi`), Opera (`com.operasoftware.Opera`), Zen
(`app.zen-browser.zen`), and Dia (`company.thebrowser.dia`). Any other
frontmost application with an active microphone gets a generic microphone offer
after 3 seconds.

No entitlement or Info.plist usage string is added for this slice.

## What is observed and where it goes

Only local metadata: whether the microphone or camera is in use and which app
is using the microphone or in front (name and bundle identifier); never audio,
video frames, window titles or screen content. It stays on the Mac: the
companion receives only the offer (the application's name, its kind and an
identifier), and the notebook the name and bundle identifier to preselect.
The AppKit reads run inside an autorelease pool each poll. Nothing is read
while the setting is off: the watcher thread checks the setting and returns
before any read.

## The app has to be running

TalkQTE notices a call only while it is running. Three things make that
dependable, each the person's choice:

- The setting is saved, so once turned on it stays on at the next launch.
- **Settings → Menu bar and login → Keep running in the menu bar when the
  notebook is closed** (off by default). With it on, closing the notebook
  leaves TalkQTE in the menu bar and out of the Dock, still watching if the
  prompt is on. With it off, closing the notebook quits, as before.
- **Open at login** (off by default) registers TalkQTE with macOS
  (`SMAppService`) so it opens when the person logs in. The state shown is
  read back from macOS each time; macOS may ask for approval in System
  Settings → General → Login Items.

The menu bar item shows whether a session is running and has **Open
notebook**, **Start session…**, **Stop session** (only while one runs), the
prompt's on/off switch and **Quit TalkQTE**. Start session… opens the
notebook's usual start, as the offer's Start does; nothing is chosen,
approved or captured from the menu bar. An offer's Start brings the notebook
back from the menu bar too.

## Code and tests

`src-tauri/src/call_prompt.rs` holds the rules (`Watcher`) and the macOS reads
(`native`); `call_prompt_commands.rs` holds the commands and the watcher
thread. The companion may only answer an offer (`respond_to_call_prompt`);
the settings commands are the notebook's (`tests/privacy_boundaries.rs`).
Scripted tests cover: off by default and nothing offered while off; the
1.5-second preview settle for known meeting apps and browsers vs 3-second
generic settle; background meeting app holding the microphone while another app
is frontmost; camera-preview trigger with muted microphone; self-PID and
self-bundle exclusion (`app.talkqte.*` / `com.talkqte.*`); one offer per spell;
withdrawal when signals stop, when TalkQTE listens, or when the prompt is
turned off; meeting, browser and unknown applications; all expanded provider
names; stale answers; Not for this app; Don't ask again; and the companion's
mode. Browser tests cover the companion's wording and buttons at its cue size,
Start preselecting the application in the notebook without listing, and the
setting.

## Not established

Whether the Core Audio Process Object List (`kAudioHardwarePropertyProcessObjectList`),
macOS 14.0–14.1 fallback (`kAudioDevicePropertyDeviceIsRunningSomewhere`), and
CoreMediaIO camera metadata (`kCMIODevicePropertyDeviceIsRunningSomewhere`) read
as expected for every meeting application and virtual camera driver on a real
device (Zoom can open the microphone in its waiting room; Teams and browsers
may keep it open between calls); false offers from dictation, voice memos or
Siri; reading the frontmost application and `NSRunningApplication` from a
background thread on a device; the companion appearing above full-screen
meeting windows; whether 1.5 s, 3 s and 45 s feel right.
