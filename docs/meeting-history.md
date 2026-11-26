# Kept meetings

Built 24 November 2026 (distilled UI copy updated 25 November 2026). The notebook can keep a meeting after it ends, so it works as a record for someone with no other note-taker. This page describes what the code does. The evidence is offline tests with fictional meetings; no build has kept a real meeting on a device yet.

## Keeping a meeting

By default, non-empty live sessions save automatically into local **Meetings** history when they stop, with a floating dock card to review, write cited notes, open, or delete right away. Lab runs never read, write, or auto-save to kept meetings.

- **Save automatically (default, `auto`).** When a live session with transcript lines or manual notes stops, TalkQTE saves it under a date-and-time title (for example, `"Meeting, 24 Nov 2026, 14:05"`), without recording the captured application's name. The floating companion shows **`Meeting saved`** with counts only (lines and whether notes exist, never transcript text, notes, titles, IDs, or app names) plus **Write notes** (when transcript lines exist, bringing Notebook forward to the explicit confirmation plan), **Open**, **Delete**, and **Dismiss**. In Notebook, `KeepInHistory.tsx` shows **`Saved to Meetings as "…"`** so you can update later note edits or rename it in **Meetings**.
- **Ask each time (`ask`).** Under **Settings → Meetings → After a live session ends**, choosing **Ask each time** holds writes until chosen: the floating companion shows **`Meeting ended`** with **Keep meeting** (briefly confirming **`Kept`**), **Write notes**, and **Dismiss**, while Notebook shows **Save this meeting?** below meeting notes with an editable **Title** and optional **Include application name (…)** checkbox. **Not this one**, **Dismiss**, quitting, or starting another session stores nothing.
- **Don’t save (`off`).** Neither auto-saves nor shows a post-session dock card or notebook offer. The **Settings → Meetings → After a live session ends** preference persists in `settings.json` (and resets to **Save automatically (default)** on **Reset settings**).
- Once saved (whether auto-saved or manually saved), notes typed afterwards, meeting notes kept afterwards, or echo answers change nothing on disk until the person chooses **Update saved meeting**, which appears only when the session differs from what was saved. A new session ends that link: a saved meeting is only ever updated from the session it came from.
- **Meetings page (`src/components/MeetingHistory.tsx`).** Lists saved meetings newest first, searches across titles, notes, kept meeting notes, cues and transcript text, opens any meeting read-only (metadata, notes, kept meeting notes, cues shown and transcript with `You`/`Them` and echo labels), renames a meeting inline, archives or unarchives a meeting (with a **Show archived** filter), deletes one with an inline confirmation, and exports a saved meeting as Markdown through the same preview-before-destination dialog.
- **Prior context (`Auto` selection & `Choose kept meetings`).** When **Settings → Meetings → Auto-select relevant past meetings as prior context** is on (default; never enabled or read/written in lab runs), TalkQTE pre-selects up to 3 non-archived kept meetings that hold kept meeting notes or user notes (`suggest_prior_context` in `src-tauri/src/meeting_history.rs`), ranking by keyword overlap with Focus and session title first and falling back to most recent. Auto-selected items appear in **Prior context** labelled `Auto` with **Remove** (stays removed for that session) and **Archive** (permanently excluded from auto-selection until unarchived). **Choose kept meetings** still lets the person manually pick any kept meeting's notes (`HistorySource`). In both cases, only kept meeting notes and user notes (bounded to 2,000 characters, never transcripts, cues, or application names) enter memory and appear in the session's processing review only if explicitly ticked (`prior:history:<id>`).
- The export review's **Include transcript and shown cues** is unchanged: it only decides whether that one Markdown export includes the transcript and cues.

## What a kept meeting holds

| Kept                                                                  | Never kept                                         |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| Title (editable)                                                      | Audio                                              |
| Start date and time, and length                                       | Provider keys or tokens                            |
| Sources used: microphone, application or both                         | The application's name, unless the person ticks it |
| Transcript, times from the start                                      | The person's name setting and focus lines          |
| You/Them labels, 0-based remote speaker IDs, and custom speaker names | Imported notes and note reminders                  |
| Likely-echo marks, for lines neither removed nor kept as their own    | Imported notes and note reminders                  |
| The person's notes                                                    | The Still open list                                |
| Cues shown from the conversation, with the line each quoted           | Cue usage, spend or provider replies               |
| Meeting notes, only if the person kept them, as edited                | Anything from a lab run                            |
| The transcription service's name (Deepgram)                           |                                                    |

The engine builds this (`Engine::keepable_meeting`, `src-tauri/src/engine/history.rs`)
with the same exclusions as an export that keeps the meeting.

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
  not shown. It calls `settings::lab_run()` so kept meetings and the settings
  file share the exact same guard.

## Commands

History storage and management commands are notebook-only
(`capabilities/main.json`, checked in `tests/privacy_boundaries.rs`). The
companion receives only `endPrompt` counts/state and permits only
`respond_to_end_prompt` (`capabilities/cue.json`). File work runs off the main
thread (`src-tauri/src/meeting_history_commands.rs`).

| Command                          | Does                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `meeting_history_status`         | Availability, persisted `afterSessionKeep` (`auto`, `ask`, `off`), `autoPriorContext`, session number, kept meeting and whether it changed |
| `set_after_session_keep`         | Persists `afterSessionKeep` (`auto`, `ask`, `off`) in `settings.json`                                                                      |
| `set_auto_prior_context`         | Persists `autoPriorContext` in `settings.json` and refreshes auto-selected prior context                                                   |
| `respond_to_end_prompt`          | Companion dock action for an ended non-empty live session (`keep`, `writeNotes`, `open`, `delete`, `dismiss`)                              |
| `keep_meeting_in_history`        | Keeps the ended session under a title, optionally with the application's name                                                              |
| `update_kept_session_meeting`    | Writes the same session's later changes to its kept meeting                                                                                |
| `kept_meetings`                  | The list, newest first, optionally filtered by a search                                                                                    |
| `open_kept_meeting`              | One meeting in full                                                                                                                        |
| `rename_kept_meeting`            | A new title                                                                                                                                |
| `rename_kept_meeting_speaker`    | Renames a diarized remote speaker (`Speaker 1`, etc.) in a kept meeting                                                                    |
| `set_kept_meeting_archived`      | Marks a kept meeting archived/unarchived (excluded from auto prior context when archived)                                                  |
| `delete_kept_meeting`            | Deletes one for good                                                                                                                       |
| `delete_all_kept_meetings`       | Deletes the whole folder                                                                                                                   |
| `kept_meeting_export_preview`    | Builds the Markdown preview for one kept meeting and holds it for save                                                                     |
| `export_kept_meeting`            | Saves the exact reviewed Markdown for a kept meeting through the native dialog                                                             |
| `list_kept_meetings_for_context` | Lists kept meetings' notes and meeting notes (never transcripts) for Prior context selection                                               |

## Evidence

- `cargo test --manifest-path src-tauri/Cargo.toml`: `settings` (`afterSessionKeep`
  defaults to `auto` and parses `auto`/`ask`/`off`), `companion` (opens for
  `end_prompt` when not hidden), `tests/privacy_boundaries.rs` (companion
  capability permits `respond_to_end_prompt` only and `CueSnapshot` carries
  counts without transcript text, notes, titles, IDs, or app names),
  `meeting_history` (round trip, newest first and search, owner-only modes and
  no leftover temporary file, exact fields stored, newer index and newer
  meeting left untouched, damaged, version-less, oversized, foreign and
  out-of-bounds files neither shown nor rewritten, ids and titles checked before
  any write, full history refused, update keeps the title, lab runs and missing
  folder read and write nothing, every lab setting turns it off, fixed version-1
  file is read, kept-meeting Markdown export omits unkept fields), and
  `engine::history` (offers nothing before the end or when completely empty,
  drops provider speaker labels, keeps You/Them and echo marks with both sources,
  and keeps the application's name only when asked).
- `tests/meeting-history.spec.ts` and `tests/dock-end-prompt.spec.ts` (browser,
  a fictional stand-in for the commands): default auto-save on stop without
  application name, companion `Meeting saved` / `Meeting ended` (`Ask` mode) /
  `Kept` cards, **Write notes** opening the confirmation plan without sending,
  **Open** opening the kept meeting, **Delete** removing it, **Off** and lab
  runs saving nothing, inline retry on failure, later notes updates via **Update
  kept meeting**, Settings `After a live session ends` selector and **Delete all
  meetings** confirmation, and the **Meetings** page (newest-first list, search,
  read-only detail, rename, reviewed Markdown export, delete confirmation,
  narrow layout, unreadable/newer/lab-run notices).
- `tests/accessibility.spec.ts`: automated axe-core checks on the **Meetings**
  list, opened meeting detail and export review dialog.

## What a real run must confirm

- A kept meeting written by a signed build on a device, at mode 700/600,
  under the real Application Support folder, and still there after an update.
- A long meeting (two hours or more) keeps and opens within a reasonable time.
- A rollback between two signed candidates leaves a newer history untouched.
- Time Machine and FileVault behaviour as described.
