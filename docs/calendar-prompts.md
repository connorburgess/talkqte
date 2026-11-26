# Calendar pre-call prompts

Calendar prompts are off by default and available only on macOS outside lab runs.
Enable **Settings → Calendar & call prompts → Use macOS Calendar for upcoming
meetings** to request EventKit access. Apple Calendar must already sync the
Google Calendar, iCloud, or Outlook/Exchange account; TalkQTE adds no cloud OAuth
connection. If permission is denied, the setting links to **System Settings →
Privacy & Security → Calendars**. Other platforms show an unavailable explanation.

While enabled and idle, a Rust worker polls every 15 seconds for events starting
within the next five minutes or the previous ten minutes. EventKit may return
other overlapping events; their start times are filtered before reading titles
or link fields. All-day events are skipped. For eligible events, URL, location,
and notes text are inspected transiently for known meeting domains or the huddle
marker, then discarded. Attendees and organizers are never accessed. The adapter
retains only an occurrence identifier, sanitized title, timestamps, and a meeting
link boolean. It uses the existing objc2, Foundation, and block2 dependencies with
a small EventKit framework bridge; no dependency or license notice is added.

About two minutes before start, one dock card offers **Start listening** and
**Dismiss**. The same occurrence is offered once per app launch (a recurring
meeting's next occurrence is separate). A prompt disappears when the event ends,
changes outside the window, loses its meeting link, permission is revoked, or a
session starts. The companion receives only a numeric prompt ID, title bounded
to 120 characters, and rounded minutes until start. It never receives event IDs,
URLs, descriptions, locations, attendees, or the live session's meeting title.

**Start listening** opens the notebook with an editable default meeting title;
it does not start capture. **Start live session** then uses that title for the
local session and kept-meeting record. **Clear** explicitly starts without the
calendar title. Starting directly from the notebook while an offer is visible
also uses the matched title. Titles never enter transcription or cue-provider
requests. Turning Calendar prompts off clears the native pending title and offer.
The setting is backward compatible with settings version 1 and defaults to false.
Lab runs use an unavailable source and never query or request Calendar access.

## Acceptance and next blocker

Offline tests use fictional event sources and browser stand-ins. They cover
provider detection, timing, occurrence deduplication, opt-out, narrow companion
payloads, permission states, and title handoff. They do not establish native
permission or presentation behavior.

The next readiness blocker is a separately authorized native acceptance run with
a fictional calendar and provider dispatch disabled: verify first permission
request, denial and later recovery, relaunch with the toggle off/on, event edits
and recurring occurrences, focus-preserving dock presentation at standard and
large sizes, and the title in a local kept meeting. Check macOS 14+ full access
and the legacy authorization fallback on a supported older OS. No roadmap
capability is marked complete by this implementation or its browser fixtures.
