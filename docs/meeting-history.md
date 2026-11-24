# Kept meetings

Built 24 November 2026. The notebook can keep a meeting after it ends, so it
works as a record for someone with no other note-taker. This page describes
what the code does. The evidence is offline tests with fictional meetings;
no build has kept a real meeting on a device yet.

## Keeping a meeting

Nothing is kept unless the person keeps that meeting.

- After a live session with a transcript ends, the notebook shows **Keep this
  meeting?** below the meeting notes, with a **Title** (by default the date
  and time, for example "Meeting, 24 Nov 2026, 14:05"), **Keep meeting** and
  **Not this one**. In a session that heard an application, **Also keep the
  application's name (…)** is offered, unticked.
- **Not this one**, quitting, or starting another session stores nothing.
  The next meeting is offered again.
- **Settings → Kept meetings → Offer to keep each meeting** turns the
  question off. It is on by default, because offering stores nothing, and
  lasts until quit; it moves into the settings file once that file is
  merged ([release path](release-path.md#recoverable-upgrades)).
- Once kept, the card says **Kept in your meetings as "…"**. Notes typed
  afterwards, meeting notes kept afterwards, or echo answers change nothing
  on disk until the person chooses **Update kept meeting**, which appears only
  when the session differs from what was kept. A new session ends that link:
  a kept meeting is only ever updated from the session it came from.
- The export review's **Also keep this meeting** is unchanged: it only
  decides whether that one Markdown export includes the transcript and cues.

## Finding, opening and deleting

- **Meetings** in the sidebar opens the list: newest first, each row with its
  title, date and time, length, sources and whether it has meeting notes.
  **Search titles and text** matches every word typed, ignoring case, against
  the title, notes, meeting notes, transcript and cues; it runs in Rust on
  this Mac, a quarter of a second after typing stops.
- Choosing a row opens the meeting read-only: meeting notes, the person's
  notes, the cues shown, and the transcript with You/Them and likely-echo
  marks. Nothing on the page is editable except through:
  - **Rename** (a title of up to 200 characters),
  - **Export…** (Markdown in the export's shape, headed by the title, date
    in UTC, length and sources; the file is named `talkqte-meeting-<date>.md`,
    never by the title; the system save dialog chooses where),
  - **Delete…** (an inline confirmation; the meeting's folder is removed).
- A meeting that could not be read is counted under the list and left as it
  is; Settings → **Delete all meetings** removes it.

## What a kept meeting holds

| Kept                                                               | Never kept                                         |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| Title (editable)                                                   | Audio                                              |
| Start date and time, and length                                    | Provider keys or tokens                            |
| Sources used: microphone, application or both                      | The application's name, unless the person ticks it |
| Transcript, times from the start                                   | The transcription provider's speaker labels        |
| You/Them labels, only in a session with both sources               | The name setting and focus lines                   |
| Likely-echo marks, for lines neither removed nor kept as their own | Imported notes and note reminders                  |
| The person's notes                                                 | The Still open list                                |
| Cues shown from the conversation, with the line each quoted        | Cue usage, spend or provider replies               |
| Meeting notes, only if the person kept them, as edited             | Anything from a lab run                            |
| The transcription service's name (Deepgram)                        |                                                    |

The engine builds this (`Engine::keepable_meeting`, `src-tauri/src/engine/history.rs`)
with the same exclusions as an export that keeps the meeting.

## Past meetings as prior context

First slice, built 24 November 2026 (`src-tauri/src/meeting_context.rs`).

**Choosing.**

- **Prior context → Choose kept meetings** opens the same chooser as a notes
  file. It lists, newest first (up to 200), the kept meetings that have kept
  meeting notes or notes of the person's.
- Only the ones ticked are imported, up to 5 per import, within the store's
  20-note limit. They then sit under Prior context as "From a kept meeting:
  its meeting notes and your notes".
- **Remove** and **Remove all** work as for any note. Deleting the kept
  meeting, or **Delete all meetings**, also removes its copy from prior
  context and closes an open chooser of kept meetings.

**What a chosen meeting contributes.** One prior note (provider `meeting`):

- `title`: the meeting's title.
- `sourceDate`: its local date.
- `revision`: its revision.
- `excerpt`: `Meeting notes:` and the kept meeting notes, then `Your notes:`
  and the person's notes, cut at 2,000 characters (the bound for every
  imported note).

It never carries the transcript, cues, sources or application name. The copy
is taken when it is imported; renaming the meeting later does not change it.

**Where it goes.**

- **Nowhere, unless the session's review includes it.** Importing grants no
  processing. In the review a kept meeting is listed as "Kept meeting · date
  · prior note", unticked. Ticked, the review's second step shows the exact
  text it would send and its length.
- **With your own Anthropic key: never sent.** That connection takes no
  prior notes (`without_notes()`). Its review says "Prior notes are never
  sent to this processor. Kept meetings you chose stay on this Mac."
- **A processor that takes prior notes** (today only the development lab's
  selected-context path) receives exactly that text, with the meeting's
  provider, title and date as its citation. A cue that cites it shows "Title
  · Kept meeting · date · prior note". Lab runs never read kept meetings, so
  in practice none reaches the lab either.
- **Reminders.** In a session without a cue model, the title-word rule can
  show it as a reminder labelled "kept meeting". A model-backed session (the
  own-key path) does not run that rule.

**So today a chosen meeting reaches no cue in an ordinary build.** The
plumbing, bounds, review and citation are in place. What a fuller version
would need:

1. The own-key connection accepting prior notes. This means porting the
   lab's selected-context request (`buildSelectedContextParams`: the
   selected-snapshot rule appended to the live prompt, the v2 input with
   `priorNotes`, the citation schema) to `anthropic_api.rs`, with a fixture
   shared with the lab. It also means allowing `meeting` in the JS validator.
   The [handoff](selected-context-handoff.md#concrete-next-readiness-blocker)
   requires a separate review of that input contract, and an authorized
   fictional comparison with and without selected context (useful additions,
   stale or resolved constraints, latency, cost), before this is turned on.
2. Bounds that suit meetings: a whole meeting's decisions may not fit 2,000
   characters. A fuller version would select the relevant sections and say
   what was cut.
3. Transcript excerpts, if ever: chosen lines with their times, shown in the
   review like the notes, never the whole transcript by default.
4. Refresh: re-importing after the kept meeting is updated or renamed, as
   the Granola update check does for Granola notes.
5. A real run showing that "Earlier, legal said review takes two days" comes
   back at the right moment, not as noise.

## Storage

`src-tauri/src/meeting_history.rs`, under the app's Application Support
folder (`~/Library/Application Support/com.talkqte.desktop/` on macOS):

```text
meetings/                 mode 700
  index.json              mode 600: version, and per meeting its id, title,
                          revision, start, length, sources, whether it has
                          meeting notes
  <id>/meeting.json       mode 600: version and the whole meeting
```

- **No new dependency.** JSON files with `serde_json`; identifiers are 16
  random bytes as 32 hex digits (`getrandom`), checked before any use in a
  path.
- **Atomic writes.** Each file is written to a temporary file in the same
  folder at mode 600, flushed, then renamed over the old one. A keep writes
  the meeting before the list, and removes the meeting again if the list
  cannot be written, so a failure part-way leaves the list as it was.
- **Bounded and checked on read.** At most 1,000 meetings (a further keep
  asks the person to delete one; nothing is dropped on its own), an index of
  1 MiB, a meeting file of 16 MiB, 50,000 transcript lines of 8,000
  characters, notes of 20,000 characters, 1,000 cues, kept meeting notes of
  40,000 characters, titles of 200 characters, and no control characters
  other than line breaks and tabs. Labels appear only with both sources, and
  an application name only with an application source. A meeting file that
  fails any check, belongs to another id or states no version is not shown,
  is counted as "could not be read", and is never rewritten.
- **Versions.** Both files carry `"version": 1`. A file from a newer version
  is never overwritten: a newer index makes the whole history read-only
  (Settings says so); a newer meeting file is not shown and not changed.
  Only **Delete all meetings** removes them. This is the rule the release
  path sets for the settings file. A version-1 fixture is read in a test.
- **Deleting.** Deleting a meeting removes its folder, then its list entry.
  **Delete all meetings** (Settings, with an inline confirmation) removes the
  whole `meetings` folder, including files that could not be read. Files are
  unlinked, not overwritten; copies in backups (Time Machine) or exports are
  outside TalkQTE's control.
- **Not encrypted.** The files are plain JSON on the Mac's disk under the
  person's account, protected by the folder's permissions and, if it is on,
  FileVault. [PRIVACY.md](../PRIVACY.md) says so.
- **Lab and development runs.** A launch with any lab setting
  (`TALKQTE_DEV_LAB_RUN_ID`, `TALKQTE_TIMING_LOG`, `TALKQTE_DEV_CUE_BACKEND`,
  `TALKQTE_DEV_LAB_DESCRIPTOR`, `TALKQTE_DEV_LAB_CONTEXT`,
  `TALKQTE_DEV_APPLICATION_SOURCE`, `TALKQTE_DEV_PLAYER_PID`; debug builds
  only) has no history: nothing is listed, read or written, and the offer is
  not shown. This is the same list as the settings file's guard; once that
  change is merged the two should share one function.

## Commands

All notebook-only (`capabilities/main.json`, checked in
`tests/privacy_boundaries.rs`); the companion has none. File work runs off
the main thread (`src-tauri/src/meeting_history_commands.rs`).

| Command                       | Does                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `meeting_history_status`      | Availability, the offer setting, the session number, the session's kept meeting and whether it changed |
| `set_offer_to_keep`           | The offer setting, for this launch                                                                     |
| `keep_meeting_in_history`     | Keeps the ended session under a title, optionally with the application's name                          |
| `update_kept_session_meeting` | Writes the same session's later changes to its kept meeting                                            |
| `kept_meetings`               | The list, newest first, optionally filtered by a search                                                |
| `open_kept_meeting`           | One meeting in full                                                                                    |
| `rename_kept_meeting`         | A new title                                                                                            |
| `delete_kept_meeting`         | Deletes one for good                                                                                   |
| `delete_all_kept_meetings`    | Deletes the whole folder                                                                               |

## Evidence

- `cargo test --lib meeting_history engine::history`: round trip, newest
  first and search, owner-only modes and no leftover temporary file, the
  exact fields stored, newer index and newer meeting left untouched, damaged,
  version-less, oversized, foreign and out-of-bounds files neither shown nor
  rewritten, ids and titles checked before any write, a full history refused,
  update keeps the title, lab runs and a missing folder read and write
  nothing, every lab setting turns it off, a fixed version-1 file is read;
  the engine offers nothing before the end or without a transcript, drops
  provider speaker labels, keeps You/Them and echo marks with both sources,
  and keeps the application's name only when asked.
- `tests/meeting-history.spec.ts` (browser, a fictional stand-in for the
  commands): nothing is kept without **Keep meeting**, the title and the
  application-name choice, a later notes change kept only through **Update
  kept meeting**, a failed keep, the Settings offer and **Delete all
  meetings** confirmation, and a lab run.

- The same spec covers the Meetings page: newest first and search, the empty
  and no-match states, opening read-only with focus on the title and back to
  its row, rename, export and delete with confirmation, and a meeting kept in
  this session appearing in the list. The Markdown export's content and file
  name are tested in Rust.

- `cargo test --lib meeting_context`: the excerpt order, bound and that no
  transcript text is ever included; the local date by UTC offset; the
  chooser lists only meetings with notes and imports only those ticked; lab
  runs list nothing; an imported but unselected meeting is not in the
  request, and a selected one is, exactly, with provider, title and date; the
  own-key style processor refuses a review that selects one and sends
  nothing from it; removal takes it out of the session.
- `tests/meeting-context.spec.ts`: the chooser and its import, the review
  showing nothing unless the meeting is selected and then its exact text,
  the no-prior-notes connection's wording, and deletion removing it from
  prior context.

## What a real run must confirm

- A kept meeting written by a signed build on a device, at mode 700/600,
  under the real Application Support folder, and still there after an update.
- A long meeting (two hours or more) keeps and opens within a reasonable time.
- A rollback between two signed candidates leaves a newer history untouched.
- Time Machine and FileVault behaviour as described.
