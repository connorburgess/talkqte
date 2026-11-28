# Local calendar agenda core

The notebook agenda is a separate, default-off Apple Calendar integration. Enabling
pre-call prompts does not enable the agenda, and enabling the agenda does not
turn on prompts, capture, processing, or prior-note selection. This native core
supports the notebook frontend; it does not establish native visual acceptance.
Lab runs and non-macOS builds report unavailable without Calendar access.

## Scope and projection

The local Gregorian window runs from yesterday's midnight through the end of day
+14 in the current timezone. Calendar-day arithmetic preserves daylight-saving
boundaries. At most 100 calendar summaries and 250 event occurrences are returned;
truncation is explicit. Enumeration also stops after 10,000 candidates or a
60-second deadline. EventKit may block before returning control: the deadline
rejects a late result, rather than promising interruption of the OS call.

The main window receives bounded calendar IDs, display titles and coarse source
labels, plus event titles, opaque occurrence keys, calendar identity, local dates,
timestamps, all-day status and a meeting-link boolean. Recurring occurrences have
separate keys. All-day end dates are inclusive in this projection. Cancelled and
out-of-window events are excluded. Source labels describe account types; account
names are not read. Only URL and location are inspected transiently for an
established meeting-link pattern. Agenda enumeration never reads event notes,
attendees, organizers, attachments or alarms, and never opens a meeting link.
The existing narrow pre-call query may still inspect notes in its original window.

Events and labels stay in memory. Only the agenda opt-in and selected calendar IDs
persist in version-1 owner-only settings. Missing/null IDs mean all calendars;
`[]` means none. Removed or malformed IDs never broaden selection. The encoded selection is
bounded to 32 KiB to leave room for other preferences. A filtered-out
calendar cannot contribute events. Reset clears the agenda and restores opt-in off.
Calendar access itself sends nothing to providers. A title selected for a session
can become a kept/exported title; saved content later explicitly approved as prior
context follows the existing processing disclosure. Calendar-derived content is
not categorically exempt from those user-directed paths.

## Refresh lifecycle

One physical worker runs at a time, outside the session mutex. Concurrent refresh
requests coalesce into one rerun. Disable, reset, filter changes, timezone/day
changes and permission revocation invalidate old tickets. A blocked OS request
retains its worker slot until it returns; disable clears visible data immediately,
and late results cannot repopulate it. Cached reads check authorization without
requesting it. Only explicitly enabling the agenda may request Calendar permission.

Store changes, day/timezone changes and wake notifications debounce for 500 ms.
A five-minute fallback poll and 15/30/60/120/300-second error backoff provide
bounded retries. Failed reads retain the last successful same-scope cache with a
fixed error message; data becomes stale after ten minutes of monotonic elapsed
time. Background event queries pause during a live session. Manual refresh is
allowed while live; ending the session catches up. Returning to the notebook
refreshes a cache older than 30 seconds. No refresh starts audio or approves notes.

## Main-only contract

`calendar_agenda` returns the cached snapshot plus current authorization status.
`set_calendar_agenda(enabled)` controls the separate opt-in.
`set_included_calendars(ids)` persists an exact included set.
`refresh_calendar_agenda` requests a coalesced read without a permission prompt.
All four require the main window both in command validation and ACL.
`calendar:agenda-changed` is emitted only to main. Monotonic revisions allow the
frontend to discard stale replies. Neither engine nor companion snapshots gain
agenda events; the existing companion pre-call payload stays narrow.

Preparation is local frontend state using the existing editable session title and
start command. It must remain tied to the intended next session and must never
implicitly start capture or approve prior notes. Agenda disable does not erase an
independently prepared native pre-call title.

## Evidence and next acceptance

Fictional offline regressions cover filtering, bounded projection, occurrence
identity, stale/cancelled completions, permission races, refresh coalescing, live
pause/manual refresh, error retention, settings persistence and main-only ACL.
Foundation-only date tests cover spring/fall DST without constructing EventKit.
These checks do not read a real calendar or establish platform permission behavior.

The next acceptance is a separately authorized macOS run with a fictional calendar
and provider dispatch disabled: opt-in/deny/recover/relaunch, disable during a held
permission/read, removed calendars, event edits, wake/timezone/day rollover,
recurrence and multi-day all-day events, manual refresh while live, and keyboard/
VoiceOver use of the integrated frontend. Verify supported macOS EventKit behavior
and real OS-call responsiveness. No roadmap item or distribution gate is completed
by the native implementation or browser stand-ins alone.
