# Kept meetings

Built 24 November 2026 (distilled UI copy updated 25 November 2026). The notebook can keep a meeting after it ends, so it works as a record for someone with no other note-taker. This page describes what the code does. The evidence is offline tests with fictional meetings; no build has kept a real meeting on a device yet.

## Capture disclosure and transcript retention

The live capture panel explains transcript saving independently of whether a cue processor is configured. **Save automatically** requests a local save of non-empty sessions on stop; **Ask each time** waits for a keep choice; **Don’t save** leaves the current session in memory. Lab runs do not save meetings. These are conditional descriptions of the settings, not a claim that a save succeeded; the ended-session status reports the result.

This is about the meeting transcript, not questions sent to Ask or model answers. The separate [live Ask change](https://github.com/connorburgess/talkqte/pull/476) keeps its Q&A in session memory and excludes it from saved meetings. That feature is not introduced by this disclosure correction.

## Keeping a meeting

By default, non-empty live sessions save automatically into local **Meetings** history when they stop, with a floating dock card to review, write cited notes, open, or delete right away. Lab runs never read, write, or auto-save to kept meetings.

- **Save automatically (default, `auto`).** When a live session with transcript lines or manual notes stops, TalkQTE saves it under a date-and-time title (for example, `"Meeting, 24 Nov 2026, 14:05"`), without recording the captured application's name. The floating companion shows **`Meeting saved`** with counts only (lines and whether notes exist, never transcript text, notes, titles, IDs, or app names) plus **Write notes** (when transcript lines exist, bringing Notebook forward to the explicit confirmation plan), **Open**, **Delete**, and **Dismiss**. In Notebook, `KeepInHistory.tsx` shows **`Saved to Meetings as "…"`** so you can update later note edits or rename it in **Meetings**.
- **Ask each time (`ask`).** Under **Settings → Meetings → After a live session ends**, choosing **Ask each time** holds writes until chosen: the floating companion shows **`Meeting ended`** with **Keep meeting** (briefly confirming **`Kept`**), **Write notes**, and **Dismiss**, while Notebook shows **Save this meeting?** below meeting notes with an editable **Title** and optional **Include application name (…)** checkbox. **Not this one**, **Dismiss**, quitting, or starting another session stores nothing.
- **Don’t save (`off`).** Neither auto-saves nor shows a post-session dock card or notebook offer. The **Settings → Meetings → After a live session ends** preference persists in `settings.json` (and resets to **Save automatically (default)** on **Reset settings**).
- Once saved (whether auto-saved or manually saved), notes typed afterwards, meeting notes kept afterwards, or echo answers change nothing on disk until the person chooses **Update saved meeting**, which appears only when the session differs from what was saved. A new session ends that link: a saved meeting is only ever updated from the session it came from.
- **Meetings page (`src/components/MeetingHistory.tsx`).** Lists unfiled meetings at the top in saved organization order, lets people optionally create collapsible folder sections (`+ New folder`, rename, or delete a folder without deleting its meetings), searches across titles, folders, notes, kept meeting notes, cues and transcript text (auto-expanding matching folders), opens any meeting read-only (metadata, folder selector, notes, kept meeting notes, cues shown and transcript with `You`/`Them` and echo labels), moves a meeting between folders or back to unfiled, renames a meeting inline, archives/unarchives with a **Show archived** filter, deletes one with an inline confirmation, and exports a saved meeting as Markdown through the same preview-before-destination dialog.
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
| Likely-echo marks, for lines neither removed nor kept as their own    |                                                    |
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
  index.json              mode 600: version, optional folder list, and per
                          meeting its id, title, revision, start, length,
                          sources, whether it has meeting notes, and optional
                          folder
  <id>/meeting.json       mode 600: version and the whole meeting (including
                          optional folder)
```

- **No new dependency.** JSON files with `serde_json`; identifiers are 16
  random bytes as 32 hex digits (`getrandom`), checked before any use in a
  path.
- **Atomic writes.** Each file is written to a temporary file in the same
  folder at mode 600, flushed, then renamed over the old one. A keep writes
  the meeting before the list, and removes the meeting again if the list
  cannot be written, so a failure part-way leaves the list as it was.
- **Folder changes.** Optional names (up to 80 characters, 200 folders) and assignments live in the local index. Older version-1 files without folders remain readable. The atomic index is the assignment commit point: if a rename or deletion stops between file writes, listing, searching, opening, and later updates use the last committed assignment. Folder names never enter provider context or exports. Deleting a folder unfiles its meetings and preserves their archive state.
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
- **Deleting.** Before deleting any meeting content, TalkQTE prepares and
  flushes the replacement index to a temporary file. If that preparation
  fails (for example, because the disk is full), Delete reports a write error
  and leaves the saved meeting and committed index intact for retry. It then
  removes the meeting's folder and renames the prepared index into place.
  These two operations are not a transaction: interruption during removal or
  failure of the final rename can still leave a missing or partially removed
  meeting referenced by the old index. There is no crash-recovery journal or
  power-loss durability guarantee.
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
| `kept_meetings`                  | The list in saved organization order, optionally filtered by a search                                                                      |
| `open_kept_meeting`              | One meeting in full                                                                                                                        |
| `rename_kept_meeting`            | A new title                                                                                                                                |
| `rename_kept_meeting_speaker`    | Renames a diarized remote speaker (`Speaker 1`, etc.) in a kept meeting                                                                    |
| `set_kept_meeting_archived`      | Marks a kept meeting archived/unarchived (excluded from auto prior context when archived)                                                  |
| `delete_kept_meeting`            | Deletes one for good                                                                                                                       |
| `delete_all_kept_meetings`       | Deletes the whole folder                                                                                                                   |
| `kept_meeting_export_preview`    | Builds the Markdown preview for one kept meeting and holds it for save                                                                     |
| `export_kept_meeting`            | Saves the exact reviewed Markdown for a kept meeting through the native dialog                                                             |
| `list_kept_meetings_for_context` | Lists kept meetings' notes and meeting notes (never transcripts) for Prior context selection                                               |
| `create_meeting_folder`          | Creates an optional local folder name in `index.json`                                                                                      |
| `rename_meeting_folder`          | Renames a folder and updates every meeting assigned to it                                                                                  |
| `delete_meeting_folder`          | Removes a folder and moves its meetings back to unfiled (never deletes meetings)                                                           |
| `set_kept_meeting_folder`        | Assigns a kept meeting to a folder or `null` to unfile                                                                                     |

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
  file is read, kept-meeting Markdown export omits unkept fields, and folder create/rename/delete/assign keep unfiled meetings, preserve meetings when deleting a folder, block lab runs, and reject out-of-bounds folder names), and
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
  meetings** confirmation, and the **Meetings** page (newest-first unfiled list,
  optional collapsible folder sections with create/rename/delete and moving
  meetings without losing any on folder delete, search across folders,
  read-only detail with folder selector, rename, reviewed Markdown export,
  delete confirmation, narrow layout, unreadable/newer/lab-run notices).
- `tests/accessibility.spec.ts`: automated axe-core checks on the **Meetings**
  list, opened meeting detail and export review dialog.

## What a real run must confirm

- A kept meeting written by a signed build on a device, at mode 700/600,
  under the real Application Support folder, and still there after an update.
- A long meeting (two hours or more) keeps and opens within a reasonable time.
- A rollback between two signed candidates leaves a newer history untouched.
- Time Machine and FileVault behaviour as described.

## Remote speaker names

Deepgram diarization IDs appear as **Speaker 1**, **Speaker 2**, and so on; missing IDs stay **Them**. Click a remote name in either Transcript to rename that speaker throughout the meeting. Enter or Save submits, leaving the editor also saves, and Escape or Cancel discards the draft. Blank input restores the numbered label. Names are limited to 80 characters, stored only with that meeting, searchable, and included in its transcript export. Existing v1 meetings without IDs or names still open unchanged. Renaming a kept meeting does not rewrite already generated notes.

Speaker numbers are provider guesses, not verified identities. After a reconnect, new remote lines use Them without an editable speaker ID for the rest of the session, preventing a reused provider ID from inheriting an earlier custom name. Start a new session to restore numbering. Confirm attribution before naming someone or relying on generated notes. Native call accuracy remains unverified. The next acceptance check is an explicitly authorized fictional macOS call covering two remote voices, reconnect, rename, stop, reopen and export, with no cross-meeting names.

## Organizing and filtering meetings

New meetings start at the top of Unfiled. Drag a meeting by its handle onto a
folder header (even collapsed) to append it, onto another row to insert before
it, or onto Unfiled to move it out of a folder. **Folder for …** is the equivalent
non-drag move control. **Move … up/down** buttons move relative to the adjacent
visible meeting in the same group and work with Tab and Enter/Space. A successful
reorder returns focus to that meeting's drag handle and announces the move;
failed writes show an inline error and leave the previous list available to retry.

The saved order survives reopening. Reordering changes only the moved meeting:
all other entries, including search-hidden, date-filtered and archived meetings,
keep their relative order. Clearing filters therefore restores them without
losing their places relative to each other. Renaming, notes updates and archiving
do not sort the list again. Folder deletion preserves the existing order while
unfiling its meetings. New saves start at the top; automatic prior-context ranking
continues to use relevance/recency rather than the manual display order.

**From date** and **To date** are inclusive, using the local calendar date of the
meeting's start. **Has notes** includes nonblank user notes or kept model meeting
notes; transcript and shown cues alone do not qualify. These filters combine with
search and **Show archived**. Clear filters resets date/notes choices while
preserving the search and archive choice. Invalid reversed dates explain how to
correct the range. Filters are view choices, not deletion or provider sharing.

`KeptSummary.hasNotes` is recomputed from actual readable meeting contents on
each listing, including older files whose index lacks that field. The full
listing supplies readable saved totals, archive states and unreadable counts;
turning future auto-save off does not hide existing history.

Order is an optional `order` ID list in the version-1 local index. Legacy files
without it start newest first; unknown order IDs are ignored and omitted IDs
retain date order at the end. The notebook-only `position_kept_meeting` command
validates the moved ID, canonical destination folder, distinct anchor ID and
anchor's folder scope. Only the atomic index commits position/folder assignment;
a failed multi-file write cannot remove meeting contents. Older app builds may
ignore/reset custom order, so backward compatibility is content compatibility,
not preservation of this new preference across a downgrade.

Fictional Rust tests cover migration, reopen, scoped validation, hidden/archived
relative ordering, later edits, notes metadata and lab exclusion. Chromium and
WebKit checks cover drag, keyboard alternatives, combined filters, focus,
narrow layout, automated accessibility and error recovery. Real Tauri drag and
native VoiceOver behavior remain unverified. Next acceptance: an authorized
fictional native run moves/reorders with active filters, relaunches, clears them,
and confirms keyboard/VoiceOver feedback without lost meetings or note changes.

## Write-failure acceptance and remaining recovery work

The persistence regressions use separate fictional temporary stores and
injected filesystem failures; they never fill the host disk or read installed
app history. A refused index temporary file must leave a failed single Delete
listed, readable with its exact original content after reopening, and deletable
on retry after the fault is removed. An injected partial write with a
`StorageFull` error must preserve the previous meeting bytes; dropping a fully
prepared replacement before commit must also preserve them and remove its
temporary file. A refused directory removal must discard the prepared index
without replacing the committed list.

These checks cover failures before destructive single-meeting removal, not a
recoverable multi-file transaction. Single-meeting removal can partially
succeed before failing; final index rename failure can leave an unreadable
entry. An interrupted new keep can leave an unindexed meeting file, and an
update/rename can write its meeting file before its index write fails. Delete
all can also partially remove a history before returning an error. No recovery
journal, orphan discovery or backup restoration is implemented. Backups and
exports remain outside TalkQTE's control.

The next P1/P3/U6 acceptance gap is a separately designed recovery protocol for
those interrupted multi-file operations, tested at each destructive boundary
and across reopen, while preserving explicit deletion and newer-version
protection. Synthetic failure injection does not establish filesystem or
power-loss behavior on supported devices. No roadmap item is completed here.
