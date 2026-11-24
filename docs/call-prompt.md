# Call-starting prompt

24 November 2026. A first slice of "offer to start when a call starts". It
has run only against scripted signals and fixtures; nothing here was read
from a real microphone or application.

## What it does

When the person has turned it on (**Settings → When a call starts**), TalkQTE
watches two things once a second while it is open:

- whether another process has the default microphone running, and
- which application is frontmost.

After the microphone has been in use for 3 seconds, with no TalkQTE live
session starting or running and no microphone check on, the companion shows
one small offer: "A call seems to be starting in Zoom." with **Start
session…**, **Not for Zoom**, **Don't ask again** and **Not now**. It goes
away by itself after 45 seconds or when the microphone stops, and appears
once per spell of microphone use. After **Not now**, or an offer left to go
away, the same application is not offered again for 20 minutes, so a call in
which the microphone briefly stops (a mute, a device change) is asked about
once. The companion never takes focus, and a
companion the person hid stays hidden.

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
| Default input device "running somewhere" (`kAudioDevicePropertyDeviceIsRunningSomewhere`, Core Audio) | No permission, no entitlement; a property read that opens nothing. TalkQTE's own use counts too, so the watcher ignores spells in which TalkQTE was listening. | Yes: the trigger. |
| Frontmost application (`NSWorkspace.frontmostApplication`: name and bundle identifier) | No permission. | Yes: which application to preselect. |
| A known meeting application launching or coming to the front | No permission. | No: opening Zoom or Teams is not a call, so on its own it would prompt too often. It only names the application when the microphone is in use. |
| Which browser tab holds a call (Google Meet) | Window titles need Screen Recording or Accessibility; tab URLs need Automation or an extension. | No. A browser in front is offered as "a call?", with the warning that a browser's audio may not be heard yet ([browser diagnostic](native-application-audio-host.md#selected-browser-diagnostic--14-november-2026)). |
| A calendar meeting about to start (EventKit) | Calendar access (`NSCalendarsFullAccessUsageDescription`, a macOS prompt). | No: a later, opt-in step. |

Known meeting applications, by bundle identifier: Zoom (`us.zoom.xos`),
Microsoft Teams (`com.microsoft.teams2`, `com.microsoft.teams`), FaceTime,
Webex (`com.cisco.webexmeetingsapp`, `Cisco-Systems.Spark`) and Slack.
Browsers: Chrome, Safari, Arc, Firefox, Edge and Brave. Any other frontmost
application gets a microphone-only offer.

No entitlement or Info.plist usage string is added for this slice.

## What is observed and where it goes

Whether the microphone is in use and the frontmost application's name and
bundle identifier; never audio, window titles or screen content. It stays on
the Mac: the companion receives only the offer (the application's name, its
kind and an identifier), and the notebook the name and bundle identifier to
preselect. The frontmost read runs inside an autorelease pool each second. Nothing is read while the setting is off: the
watcher thread checks the setting and returns before any read.

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
3-second settle; one offer per spell; withdrawal when the microphone stops,
when TalkQTE listens, or when the prompt is turned off; meeting, browser and
unknown applications; stale answers; Not for this app; Don't ask again; and
the companion's mode. Browser tests cover the companion's wording and
buttons at its cue size, Start preselecting the application in the notebook
without listing, and the setting.

## Not established

Whether the Core Audio property reads as expected for each meeting
application (Zoom can open the microphone in its waiting room; Teams and
browsers may keep it open between calls); false offers from dictation, voice
memos or Siri; reading the frontmost application from a background thread
on a device; the companion appearing above full-screen meeting windows;
whether 3 s and 45 s feel right.
