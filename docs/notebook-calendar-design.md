# Notebook Calendar Home — Design & Implementation Contract

**Status: Built (pending native macOS verification).** The bounded local EventKit agenda core ([docs/calendar-agenda.md](calendar-agenda.md)), Notebook Calendar Home (`src/components/CalendarAgenda.tsx`), Live Schedule Glance, and Settings controls (`src/components/CalendarSettings.tsx`) are implemented alongside the Direction C reference prototype ([docs/brand/notebook-calendar.html](brand/notebook-calendar.html)). Native macOS verification with a fictional Apple Calendar and provider dispatch disabled remains the next acceptance gate before marking roadmap completion.

---

## 1. Product Goal & Design Direction

TalkQTE exists to help a participant stay grounded and respond in the moment — not to become a scheduling or calendar-editing app. Today, the Notebook Ready screen shows a blank editor beside an idle `Cues · STANDBY` card until a live session starts. Bringing an **agenda-first Calendar Home** into Notebook Ready gives the user immediate orientation around today’s and upcoming meetings so they can prepare working notes, Focus topics, and prior context for a specific meeting in one click — while **tucking the calendar completely out of the way the moment a live session starts**.

### Key UX Principles (Direction C — White and Studio Amber)

- **Agenda-first when Ready; Session-first when Live:**
  - **Ready state:** Full-width restrained date/week navigation strip (`Prev` / `Today` / `Next` + 7-day strip with tabular mono numerals and subtle square event markers) above a balanced two-column split: chronological **Agenda** on the left, **Prepare Notebook** pane on the right (editable local session title, `Start live session` with immediate sending disclosure, Working notes, optional `This meeting` Focus and `Prior context` disclosures, and compact `Cues · STANDBY`).
  - **Live state:** Starting a live session collapses the calendar completely so `MicrophoneControl`, `ProcessingControl`, `Notes / Transcript / Ask`, and `CueCard` retain the full uncrowded workspace. A quiet `Glance at schedule` button in the toolbar lets a user inspect upcoming meetings without interrupting capture, pinned beneath an unmistakable **Return to live session** banner (showing elapsed clock, active title, `Return to live session`, and `Stop live session`).
  - **Zero silent capture or provider calls:** Selecting an event only updates the local Prepare Notebook pane (title + local matching prior-context suggestions). Capture, transcription, and cue evaluation remain gated strictly behind explicit `Start live session`.
  - **Always usable without a calendar:** Disconnected, denied, empty-day, and loading states keep **Prepare ad-hoc session** and `Start live session` directly reachable.
- **Settings owns configuration; Home owns action:** Calendar enablement, per-calendar visibility checkboxes, and permission recovery live in **Settings → Calendar**, linked contextually from the sync status row on Home.
- **Visual identity:** Uses Direction C tokens (`src/tokens.css`), upright `Manrope Variable` + tabular `IBM Plex Mono`, pure white canvas, Drafting Vellum sidebar, Amber Ink (`#875500`) accents on light surfaces, uniform all-round borders (zero one-sided accent borders), and `--cue-asked-surface` (`#fdf6e9`) + uniform `1.5px solid var(--accent-ink)` border for an ongoing (`NOW`) meeting.

---

## 2. Current Implementation Audit (`4c77bf6`)

Before expanding scope, the existing calendar implementation in `4c77bf6` was inspected directly (`src-tauri/src/calendar.rs`, `src-tauri/src/calendar_commands.rs`, `src-tauri/Info.plist`, `src/components/CalendarSettings.tsx`, `src/components/CalendarPrompt.tsx`, and [docs/calendar-prompts.md](calendar-prompts.md)):

| Area | Current `4c77bf6` behavior (verified in source) |
| --- | --- |
| **Platform & adapter** | macOS-only via `EventKit.framework` (`objc2`, `objc2_foundation`, `block2`). Lab runs and non-macOS use `UnavailableSource`. |
| **Direct Google / Microsoft OAuth** | **Does not exist.** Google Calendar, iCloud, and Outlook/Exchange appear only if already synced into macOS **Apple Calendar**. |
| **Permission & Info.plist** | `EKEventStore.authorizationStatusForEntityType(0)` (`EKEntityTypeEvent = 0`), requesting `requestFullAccessToEventsWithCompletion:` (macOS 14+) with legacy fallback. `Info.plist` describes reading upcoming meeting titles/links for pre-call prompts only. |
| **Query window & cadence** | Tight 15-minute window only: `IN_PROGRESS_WINDOW_SECS = 600` (`-10m`) to `UPCOMING_WINDOW_SECS = 300` (`+5m`), polled every `15s` on thread `talkqte-calendar` only while enabled and `!runtime.live_session_open()`. |
| **Retained fields** | `id` (`eventIdentifier`), sanitized `title` (max 120 chars), `start_epoch_s`, `end_epoch_s`, `has_meeting_link` (boolean; `URL`/`location`/`notes` inspected transiently then discarded), `is_all_day` (always skipped). Attendees and organizers are never accessed. |
| **Cancellation & companion boundary** | Monotonic `settings_revision` discards late permission/query replies on disable/reset. Companion receives only `Prompt { id, title, minutes_until_start }`. |

---

## 3. Explicit Scope Expansion & Consent Plan (No Silent Expansion)

Supporting a multi-day Notebook Calendar Home widens local EventKit reads beyond the current 15-minute pre-call prompt window. This expansion **must be explicit and opt-in** — never silently enabled for users who only turned on pre-call prompts:

1. **Separate opt-in preference:** Add `calendarAgenda: bool` (default `false`) and `calendarSelectedIds: Option<Vec<String>>` (`None` = all non-hidden user calendars) in `settings.json` (backward-compatible v1 extension), distinct from `calendarPrompts: bool`. Existing users with `calendarPrompts: true` keep pre-call prompts only until they explicitly enable Notebook Calendar Home.
2. **Updated `Info.plist` disclosure:** Update `NSCalendarsFullAccessUsageDescription` / `NSCalendarsUsageDescription` before shipping to accurately describe both optional local uses (Notebook upcoming agenda and pre-call prompts) and affirm that calendar data stays on this Mac.
3. **Bounded horizon, projection boundaries & fields:**
   - **Horizon (confirmed default):** Local yesterday `00:00` through `+14 days` `23:59:59` (`[-1d, +14d]`, 16 calendar days max), hard-capped at `250` normalized events per snapshot. Navigating beyond the horizon is intentionally unsupported.
   - **Additional local metadata retained:** `is_all_day: bool` (displayed on the day’s all-day strip; still excluded from pre-call dock prompts), `calendar_id` (opaque local `EKCalendar.calendarIdentifier`), sanitized `calendar_title` (max 60 chars, from `EKCalendar.title`), and `source_label` (coarse `EKSource.title` shown only in Settings calendar picker).
   - **Recurring occurrences:** Keyed by `(eventIdentifier, start_epoch_s)` (or `(eventIdentifier, local_date)` for all-day events) so recurring instances never collide.
   - **Cancelled events:** Exclude `EKEventStatusCanceled` (`status == 2`) during EventKit projection.
   - **Transient link scanning vs. never-accessed fields (distinguished by path):**
     - **Existing pre-call prompt path (`[-10m, +5m]`):** Transiently reads `URL`, `location`, and `notes` inside the Rust EventKit projection solely to compute `has_meeting_link: bool`, then immediately discards the raw strings.
     - **Proposed 14-day agenda projection (`[-1d, +14d]`):** Transiently reads `URL` and `location` only (keeping `notes` restricted to the tight 15-minute pre-call prompt window so wider agenda queries do not inspect event descriptions/notes) solely to compute `hasMeetingLink: bool`, then immediately discards the raw strings. Raw `URL`, `location`, and `notes` values are **never retained in memory, serialized over IPC, logged, persisted, or rendered**.
     - **Never accessed in either path:** `attendees`, `organizer`, `attachments`, and `alarms`.

4. **Exact field-level data flow (verified against `4c77bf6` Rust source):**

| Field / destination | Exact behavior verified in `4c77bf6` |
| --- | --- |
| **Unselected agenda events & calendar metadata** (`calendar_id`, `calendar_title`, timestamps, `hasMeetingLink`) | Stay in Rust memory and main-window UI only. Never written to `settings.json`, `meetings/*.json`, exports, diagnostics, companion snapshots, or any external provider. |
| **Selected event title → Notebook session title (`Engine::state.meeting_title`)** | Populates an editable local title input (`MAX_TITLE_CHARS = 120`; user may edit or `Clear` before Start). Passed to `start_live_session` via `live_control.rs` and stored on `Engine::state.meeting_title`. |
| **Local Meetings history (`meetings/*.json`)** | When a non-empty ordinary live session saves (auto-save by default, or explicit Keep), `meeting_history_commands.rs` persists `meeting_title` as `KeptMeeting.title`. Lab runs never write history. |
| **Markdown exports (`Engine::markdown()` vs. `KeptMeeting::markdown()`)** | In-memory Notebook export (`engine.rs::markdown`) writes `# TalkQTE notes` and omits `meeting_title`. Exporting a saved meeting from **Meetings** (`meeting_history.rs::markdown`) writes `# {KeptMeeting.title}` as the reviewed Markdown H1 heading — so a calendar-selected title that becomes a kept meeting title **does** enter that reviewed export. |
| **Later Prior context (`ContextItem.title`)** | If a user later explicitly selects a saved meeting into **Prior context** and separately approves it in **Cue processing → Review processing**, that kept meeting’s `title` enters `Provenance::PriorNote.title` in the approved cue request (`cue_evaluator.rs`). Calendar selection itself never selects or sends prior notes. |
| **Live transcription (`transcription/cloud.rs`)** | Never receives `meeting_title` or agenda metadata (streams 16 kHz mono PCM audio frames only). |
| **Live cue evaluator (`cue_evaluator.rs` / `own_key_cues.rs`), Ask (`meeting_qa.rs`), and Meeting notes (`meeting_notes.rs`)** | Verified in `4c77bf6`: none of these three request builders read `Engine::meeting_title` or calendar agenda state. |
| **Diagnostics (`diagnostics.rs`) & Companion (`cue` window)** | Diagnostics never include meeting or calendar titles. The floating companion (`cue`) never receives agenda lists, calendar names, or `Engine::meeting_title`; it receives only the narrow pre-call `Prompt { id, title, minutes_until_start }` when `calendarPrompts` is on. |

5. **Direct account connectors:** Direct Google Calendar / Microsoft Graph OAuth connectors remain clearly labeled **Planned · Not built** in Settings and require separate OAuth/token/privacy design before Windows/cross-platform support.

---

## 4. Rust-Owned Refresh, Timing & State Contract

Rust owns all EventKit reads, change observation, debouncing, backoff, horizon calculation, and timezone rollover. React renders immutable snapshots and dispatches narrow commands.

### 4.1 Triggers & Cadence

| Trigger | Mechanism (macOS / Rust) | Behavior |
| --- | --- | --- |
| **OS calendar database change** (primary) | `NSNotificationCenter.defaultCenter` observer for `EKEventStoreChangedNotification` | Debounced (`500 ms` coalescing window) to collapse sync bursts into one refresh (`RefreshReason::StoreChanged`). |
| **App wake / window resume** | `NSWorkspaceDidWakeNotification` + main window focus/visibility event | Triggers refresh (`RefreshReason::AppResume`) if `> 30 s` since last refresh or snapshot is stale. |
| **Day rollover / timezone / DST change** | `NSCalendarDayChangedNotification` + `NSSystemTimeZoneDidChangeNotification` + local-midnight check | Recomputes `todayLocalDate`, `timezoneLabel`, and `[-1d, +14d]` horizon immediately and emits a fresh snapshot. |
| **Bounded fallback poll** | Dedicated `talkqte-calendar` worker thread | Polls agenda every `300 s` (`5 min`) while `calendarAgenda` is enabled, authorized, and idle. Pauses agenda polling during active live sessions (audio/transcription threads remain 100% isolated). Pre-call prompt check (`15 s`) runs only when `calendarPrompts` is enabled and idle. |
| **Manual refresh** | Main-window command `refresh_calendar_agenda` | Coalesced into the single in-flight refresh; ignored if disabled or unauthorized. |

### 4.2 Single In-Flight Refresh, Cancellation & Backoff

- **Single in-flight + coalesced rerun:** Worker tracks `in_flight: bool` and `pending_rerun: bool`. Triggers arriving while an EventKit query is active set `pending_rerun = true` instead of queuing duplicate queries. All EventKit calls run outside the `AppState` mutex lock.
- **Immediate cancellation on disconnect/disable/reset:** Disabling `calendarAgenda` or resetting settings immediately increments `settings_revision`, clears the in-memory agenda cache and `pending_calendar_title`, emits an `off` snapshot, and retires any in-flight query so late EventKit results are dropped before mutating state or persisting settings.
- **Exponential backoff on error:** On transient EventKit read failure, retain the last good `events` slice, set `syncState: "error"` and a fixed sanitized `error` message, and back off retries: `15 s → 30 s → 60 s → 120 s → 300 s` cap. Reset backoff immediately on success, manual refresh, or `EKEventStoreChangedNotification`.
- **Truthful freshness & stale state:** Every snapshot records `lastUpdatedEpochMs: Option<i64>` and `pausedWhileLive: bool`. If `now - lastUpdatedEpochMs > 10 min` (e.g., after sleep or repeated errors), Rust sets `stale: true` so the UI displays `"Stale · last updated HH:MM"`. Because EventKit reads the local macOS Calendar store, UI copy honestly states **Apple Calendar (local Mac cache)** rather than claiming live cloud sync with Google/Outlook.

### 4.3 Freshness & Revocation Handling During Live Session / Schedule Glance

Because background EventKit agenda polling pauses while a live session runs (keeping audio callbacks and transcription workers completely isolated), cached agenda state **must never imply live change tracking or fresh revocation detection**:

1. **Synchronous authorization re-check on Schedule Glance open:** When the user clicks **Glance at schedule** during a live session, Rust performs a lightweight synchronous `EKEventStore.authorizationStatusForEntityType(0)` check (an OS status read with zero EventKit database query) before returning the snapshot. If permission was revoked (`!= 3`), Rust immediately clears the cached agenda and emits `permission: "denied"` so stale events are never shown after revocation.
2. **Explicit paused-while-live disclosure:** When still authorized during a live session, Rust sets `pausedWhileLive: true` on the snapshot and the Schedule Glance status row explicitly displays **`Paused while live · cached HH:MM`** (or **`Stale · cached HH:MM (paused while live)`** if older than `10 min`) instead of claiming `Updated HH:MM`.
3. **Opt-in manual refresh & automatic resume on Stop:** An explicit **Refresh** button inside Schedule Glance lets the user request one coalesced read on the separate low-priority `talkqte-calendar` worker outside the `AppState` lock and audio callbacks (which re-checks both authorization and the bounded horizon). When the live session stops, `pausedWhileLive` clears to `false` and normal `EKEventStoreChangedNotification` + fallback refresh resumes immediately (performing a catch-up refresh if `EKEventStoreChangedNotification` fired or the cache became stale while live).

---

## 5. Narrow Tauri Command & Event Surface (Main Window Only)

All commands below are restricted to the `main` webview (`main_only(&window)`) and added to `notebook_only` in `src-tauri/tests/privacy_boundaries.rs` during implementation:

```ts
// Snapshot pushed on `calendar:agenda-changed` and returned by `calendar_agenda`
interface CalendarAgendaSnapshot {
  revision: number;
  permission: 'off' | 'connected' | 'denied' | 'unavailable';
  agendaEnabled: boolean;
  promptsEnabled: boolean;
  syncState: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
  pausedWhileLive: boolean;
  stale: boolean;
  lastUpdatedEpochMs: number | null;
  error: string | null; // fixed public string only
  todayLocalDate: string; // YYYY-MM-DD in current local timezone
  timezoneLabel: string; // e.g. "ICT · UTC+7"
  horizonStartDate: string; // YYYY-MM-DD
  horizonEndDate: string; // YYYY-MM-DD
  calendars: CalendarSourceSummary[];
  events: CalendarAgendaEvent[];
}

interface CalendarSourceSummary {
  id: string; // opaque local EKCalendar identifier
  title: string; // sanitized, max 60 chars
  sourceLabel: string; // coarse EKSource title (Settings only)
  included: boolean;
}

interface CalendarAgendaEvent {
  occurrenceKey: string; // stable per recurring instance
  title: string; // sanitized, max 120 chars
  calendarId: string;
  calendarTitle: string;
  isAllDay: boolean;
  localDate: string; // YYYY-MM-DD (authoritative for all-day & day bucketing)
  endLocalDate: string; // YYYY-MM-DD (inclusive for multi-day all-day events)
  startEpochS: number; // UTC epoch seconds (timed events)
  endEpochS: number; // UTC epoch seconds (timed events)
  hasMeetingLink: boolean;
}
```

Commands (main window only):
1. `calendar_agenda() -> CalendarAgendaSnapshot` — reads current cached Rust snapshot (never triggers an OS prompt on its own).
2. `set_calendar_agenda(enabled: bool) -> CalendarAgendaSnapshot` — updates opt-in setting, requests EventKit permission if `enabled && notDetermined`, performs initial bounded fetch, or immediately clears/cancels on disable.
3. `set_included_calendars(ids: Vec<String>) -> CalendarAgendaSnapshot` — persists selected `EKCalendar` IDs in `settings.json` and immediately re-filters/refreshes.
4. `refresh_calendar_agenda() -> CalendarAgendaSnapshot` — requests a coalesced manual refresh.
5. Existing `calendar_settings`, `set_calendar_prompts`, `open_calendar_settings`, and `respond_to_calendar_prompt` remain intact.

---

## 6. Edge Cases Covered

- **Ongoing (`NOW`) events:** Timed event where `startEpochS <= now < endEpochS` renders with `--cue-asked-surface` fill, uniform `1.5px solid var(--accent-ink)` border, and remaining time (`28 min left`). Selecting it lets the user immediately start a titled session mid-meeting.
- **All-day & multi-day events:** Bucketed by `localDate..=endLocalDate` (never shifted by timezone conversion), displayed in the quiet top all-day strip, selectable for manual prep, and excluded from automatic pre-call dock prompts.
- **Overlapping events:** Sorted deterministically (`startEpochS`, `endEpochS`, `occurrenceKey`) with an explicit `OVERLAPS` mono tag rather than squished side-by-side time columns, preserving readability at both desktop and `390px` widths.
- **Timezone travel & DST:** Timed events store UTC epoch seconds and format in the device’s current local zone; `NSSystemTimeZoneDidChangeNotification` triggers horizon recomputation; all-day events stay pinned to `localDate`.
- **Day rollover at midnight:** `NSCalendarDayChangedNotification` updates `todayLocalDate` and advances the default selection if the user was viewing Today, while preserving explicit navigation to another date.
- **Permission revoked mid-session:** While idle, the next OS notification or poll observes `authorizationStatus != 3`, immediately clears cached events and active prompts, and transitions cleanly to `Permission denied`. While a live session is active (when background agenda polling is paused), cached state is explicitly labeled `Paused while live · cached HH:MM` (never implying fresh revocation detection); opening **Glance at schedule**, clicking **Refresh**, or stopping the live session immediately re-checks `authorizationStatusForEntityType(0)` and clears cached events if revoked, without interrupting an active live session.

---

## 7. Implementation & Acceptance Plan (Before Production Runtime Edits)

1. **Rust core (`src-tauri/src/calendar.rs`, `calendar_commands.rs`, `settings.rs`):** Extend `CalendarSource` trait with `list_calendars()` and `agenda_events(start, end, included_ids)`, add `EKEventStoreChangedNotification` + day/timezone/wake observers, single-in-flight coalescer, backoff state machine, and deterministic offline unit tests with `FakeSource` covering revocation, cancellation races, midnight rollover, DST, overlaps, all-day bucketing, and 250-event cap.
2. **Privacy & ACL verification (`src-tauri/tests/privacy_boundaries.rs`, `Info.plist`):** Verify all new commands are main-window-only, companion snapshot payload is unchanged, lab runs bind `UnavailableSource`, and attendees/raw URLs/notes are never read or serialized.
3. **React Notebook Home & Settings (`src/components/CalendarHome.tsx`, `CalendarSettings.tsx`, `src/App.tsx`):** Wire the interactive layout proven in [docs/brand/notebook-calendar.html](brand/notebook-calendar.html) to `calendar_agenda` / `calendar:agenda-changed`, preserving `4c77bf6` live-session controls, `BuildVersion`, bounded Ask, and hidden-when-empty `Export Markdown…`.
4. **Automated & native acceptance gates:**
   - Headless Playwright (Chromium + WebKit): all 7 calendar states, keyboard navigation across week strip & agenda, narrow `320px`/`390px` zero-overflow, `axe` WCAG 2.2 AA, live-session collapse + `Return to live session`, and zero capture/network calls on event selection.
   - Separately authorized macOS native check with a fictional calendar: first permission grant, denial/revocation recovery, live edit reflection via `EKEventStoreChangedNotification`, wake-from-sleep refresh, and VoiceOver traversal.
   - No roadmap checkbox is marked complete until implementation and native acceptance evidence exist.

---

## 8. Confirmed Routine Defaults

1. **Separate opt-in toggles:** Keep **Show upcoming meetings on Notebook Home** (`calendarAgenda`) and **Offer pre-call dock prompt** (`calendarPrompts`) as two independent checkboxes in Settings → Calendar, preventing silent scope expansion for existing pre-call prompt users.
2. **Bounded 14-day forward horizon:** Default local horizon is yesterday through +14 days (`[-1d, +14d]`, 250-event cap) with a 7-day strip on Notebook Home.
3. **Title-matched Prior context suggestions only:** Selecting a calendar event may surface title-matched kept local Meetings as **suggestions** under `Prior context`, but must **never** silently select, import, or send them to any cue provider without explicit user selection and session processing approval.
