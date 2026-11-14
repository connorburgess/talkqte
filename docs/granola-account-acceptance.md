# Granola account acceptance: owner procedure

Status: procedure only, written 14 November 2026. Nothing here has been run. It is for the owner, on their own Mac and Granola account, to settle what fictional tests cannot: account-level evidence for **N2** (selected-note refresh), **N5** (imported notes as meeting context) and **P3** (privacy boundaries) in the [roadmap](../ROADMAP.md). The results inform those items; running the procedure does not tick anything by itself.

## Ground rules

- **Use throwaway notes only.** Create two new Granola notes for this check, with fictional text you invent, and delete them afterwards. Put a made-up marker word in each note's title and in its text, for example `kumquat-lantern-4821` and `kumquat-lantern-7365`. The title marker tells the test notes apart from real ones when ticking and deleting; the text marker lets you search files without opening or copying a real note. Make the notes around the middle of the day: TalkQTE shows a Granola note's date in UTC, so a note made near midnight can show the neighbouring day. If your Granola version cannot create a note without a meeting, record a short test meeting not tied to a calendar event with other people, with no other audio playing, in which only you speak fictional sentences.
- **Never use another person's note.** Every step uses only the two throwaway notes.
- **Record without personal content.** Write down counts, durations, yes/no answers, the app's own fixed messages, and the identity summary lines from step 6. Never record titles, note text, names, email addresses, folder or workspace names, tokens, paths under your home folder, or screenshots. The [results template](#results-template) has a column for each thing worth recording.
- **One build, opened explicitly.** From the repository checkout, build once with `npm run tauri -- build --debug --bundles app` and write down the commit. Quit any other TalkQTE copy, then always start this one: `open src-tauri/target/debug/bundle/macos/TalkQTE.app` (step 6 starts it differently, as described there). An installed TalkQTE shares the same data folders and must not be the one running.
- **Stop on surprise.** If any step shows note text, a token or another person's data where it should not be, stop, disconnect, quit the app, and report only which step and what kind of data appeared.

The steps are in order; later steps reuse the notes and connection from earlier ones. Steps 1 to 7 work on the free Basic plan, which lists and reads notes from the last 30 days. [Steps that need a paid plan](#steps-that-need-a-paid-plan) are separate and optional, and run before the clean-up in step 8.

## 1. Connect, list, import two notes, remove

1. Start the app. Open **Prior context** and choose **Connect Granola**. Sign in in the browser and return.
2. Choose **Choose Granola notes**. Record whether both throwaway notes are listed (yes/no) and whether a "more notes are not listed" line appears (yes/no).
3. Tick both throwaway notes, identified by the marker in their titles, and choose **Import 2 selected**. Record the notice (expected: "2 imported.").
4. Record, per note, whether the marker word is visible in the imported copy's text (yes/no). If it is not, stop: TalkQTE reads only Granola's private notes and summary, and without the marker in the copy, steps 5 and 7 would pass without testing anything.
5. For each imported note, compare the date shown beside it with the note's date in Granola. Record "date matches: yes/no" per note; do not record the date.
6. Remove one note with its remove button. Record whether it disappears and the other stays (yes/no).
7. Import the removed note again, so both are present for later steps. Record the notice (expected: "1 imported.").

**Expected:** both notes appear once, each labeled "From Granola" with the right date; removal removes only that note; reimporting it imports it again.

**Pass if** the markers are visible, both dates match, no note other than the two ticked ones appears, and removal and reimport behave as expected. **Fail if** an unticked note appears, a date is wrong, a duplicate appears, or removal leaves the note listed.

**Settles:** adds real-account evidence for N5's first-slice criteria, "shown beside the notebook with source and date, removable", which so far rest on a fictional file and the 11 November owner observation; N5 stays open on whether reminders help. P3, "retention/deletion", for removing one imported copy.

## 2. Edit a note in Granola, then reimport

1. In Granola, change one sentence of the first throwaway note (keep the marker word) and note the clock time when Granola shows the change as saved.
2. In TalkQTE, choose **Choose Granola notes**, tick only that note, and import it. Record the notice: "1 updated." means the edit arrived; "1 already imported." means TalkQTE did not see a newer revision.
3. If it did not arrive, repeat at about 1, 2, 5, 10 and 15 minutes after the save. Stop at the first "1 updated.".
4. Record the minutes from save to the first "1 updated.", or "not within 15 minutes".
5. Reimport the same note once more and record the notice (expected: "1 already imported.").
6. If the edit never arrived: remove the copy, import the note fresh, and record whether the changed sentence is now present (yes/no). Yes means Granola serves the edit but TalkQTE did not see a newer update time, so reimport cannot refresh this account's notes; step 6 records whether Granola sends update times at all. No means Granola had not yet made the edit available.
7. Record whether the note's date in TalkQTE is unchanged after the update (yes/no).

**Expected:** an edit arrives as "1 updated." within some delay, a repeat reimport is "already imported", the date is unchanged, and the list still shows one copy of the note.

**Pass if** the edit arrives within 15 minutes, the date is unchanged and no duplicate appears. **Fail if** a duplicate appears or the copy goes back to older text. "Not within 15 minutes" is a recorded result, not a failure; together with sub-step 6 it says whether the delay is Granola's or a missing update time.

**Settles:** N2, "Verify update availability and limits", the first measured update delay on a real account; and the validation record's next account check, "deliberately reimport a known updated note, confirm its source/date and absence of duplicates" ([import evidence](granola-import-validation.md#owner-observed-native-import-and-removal--11-november-2026)).

## 3. Make a note unavailable, then list and reimport

On the free plan, the simplest unavailable note is one you delete.

1. Delete the second throwaway note in Granola, identified by the marker in its title. Its copy in TalkQTE stays.
2. Choose **Choose Granola notes**. Record whether the deleted note still appears (yes/no). Do not compare listing counts with earlier steps: new meetings and the moving 30-day window change them.
3. If it still appears, tick it and import. Record the app's message. The fixed message for a missing note is "The selected notes could not be read. Nothing was imported. Try again, or cancel to choose other notes."
4. Record whether the copy already in TalkQTE stays listed (yes/no; expected: yes).

**Expected:** the listing stops offering the note, or importing it fails with the fixed message; the existing copy stays until you remove it.

**Pass if** nothing reports the note as imported or refreshed, and the existing copy is neither changed nor removed. **Fail if** an import succeeds with different text, or the copy disappears without your removal.

**Settles:** N2, "changed/revoked content", and the refresh plan's rule that an omitted note "does not by itself prove deletion" ([plan](selected-note-refresh-plan.md#proposed-session-contract)): this records what Granola returns for a deleted note, which no fictional test can.

## 4. Disconnect during a listing, then reconnect

Use the keyboard for this step (Tab to move, Space to press), so focus is visible.

1. Press **Choose Granola notes** and, while "Loading recent notes…" is shown, press **Disconnect Granola**.
2. Record: did the chooser open afterwards (expected: no); did an error appear (expected: no); does **Connect Granola** have keyboard focus (yes/no); do both imported copies stay (yes/no). If the listing finished before you could press Disconnect, record "too fast" and try once more; that is not a failure.
3. Connect again, list, and record whether the first throwaway note is listed (yes/no).
4. Press **Disconnect Granola** once more and record the notice (expected: "Granola disconnected. Imported notes stay until you remove them.").

**Expected:** Disconnect is available while loading, a late listing never reopens the chooser, imported copies stay, and reconnecting works.

**Pass if** all expected answers hold. **Fail if** the chooser opens after Disconnect, an old error appears after reconnecting, or imported copies disappear.

**Settles:** the Disconnect part of N2's "explicit enable/stop/disconnect" (enable and Stop belong to the update check, which a real connection does not offer), and P3, "disconnect/reconnect", on a real account ([recovery checks](granola-import-validation.md#disconnect-while-notes-are-loading)). It does not show that Granola stopped processing a request already sent.

## 5. Export excludes imported notes

1. Connect again if needed and make sure both copies are in **Prior context**. Use the notebook's **Export**, review it, and save it to a new temporary folder.
2. In Terminal, count marker matches in that file: `grep -c kumquat-lantern <file>`. Record the number (expected: 0). Delete the file.

**Pass if** the count is 0. **Fail if** it is above 0.

**Settles:** N5, "never exported", and P3, "export exclusion", with a real Granola note.

## 6. Does Granola expose a workspace or account identity?

The update check is built but stays off on a real connection, because it must bind each request to a provider-supported workspace identity ([plan](selected-note-refresh-plan.md#first-slice-one-explicit-check-simulated-provider-only)). This step looks for one without recording what it is.

1. Quit the app. From the repository checkout, start the same build from Terminal with the developer trace on, writing its output to a temporary file:

   ```sh
   app="src-tauri/target/debug/bundle/macos/TalkQTE.app"
   exe=$(ls -d "$app"/Contents/MacOS/* | head -1)
   TALKQTE_GRANOLA_TRACE=1 "$exe" 2> "$TMPDIR/granola-trace.txt"
   ```

2. Connect Granola, choose **Choose Granola notes**, import the first throwaway note, then quit.
3. Record two things, then delete the file:

   ```sh
   grep '^granola trace: identity:' "$TMPDIR/granola-trace.txt"
   grep -c 'updated_at=' "$TMPDIR/granola-trace.txt"
   rm "$TMPDIR/granola-trace.txt"
   ```

4. Record the identity lines as printed, and the `updated_at=` count. Each identity line looks like `granola trace: identity: tools/list: 8 tools; tool 5 name account=1` or `granola trace: identity: list_meetings: account=1`. Besides the fixed labels `initialize`, `tools/list`, `list_meetings` and `get_meetings`, they contain only the words `tools`, `tool`, `name`, `input`, `output`, `workspace`, `account` and `none`, counts and tool positions; never a name, a value or a tool's own name. The `updated_at=` count says whether Granola's replies carry update times (above 0) at all, which step 2 relies on.

**Reading the identity lines.** The scan matches names by their words (workspace, team, organization, tenant; account, user, email, owner, member, profile), so expect some positives that are not bindings:

- Granola documents an account-information tool (`get_account_info`), so a `tool N name account=1` line is expected. The app never calls that tool, so its reply is not scanned; whatever it returns is unknown.
- The note listing has been observed to carry the signed-in person's email as an attribute, so `list_meetings: account=1` is expected. An account identity does not say which workspace a request used.
- On accounts with several workspaces, Granola documents a workspace-switching tool, which gives a `tool N name workspace=1` line. That tool changes the workspace; it is not a field to bind to.
- `tool N input workspace=…` or `tool N output workspace=…`, or `workspace=` in a listing or note reply, is the result that matters: it suggests a field or argument naming the workspace a request runs in.

A `workspace=` result outside a tool's name is a lead, not a binding: a follow-up, separately approved, must confirm without copying values that the field identifies the active workspace and changes when it changes. Without one, the update check stays off on real accounts. A result with no such line does not prove Granola has no workspace identity, only that none is visible in the names this client already receives; reading `get_account_info` would need a code change and its own approval.

**Pass if** the lines and count are recorded. There is no fail: either answer decides the next step. If a line shows anything other than the fixed labels, words, counts and positions, stop and report it as a diagnostic defect.

**Settles:** N2, toward the plan's requirement to "verify a provider-supported binding across the request and fail closed if that cannot be established". The other trace lines are content-free outlines, but there is no need to keep them.

## 7. Files and logs after a real session

Run this after steps 1 to 6, with the app quit. These commands print only counts and index numbers; do not print the folder names, which contain your home path. Files the search cannot read are skipped silently, so that their paths are not printed either.

1. Write down the clock time you started step 1 (`start`, as `YYYY-MM-DD HH:MM:SS`).
2. First, a positive control: check that the search finds the marker in both plain and UTF-16 text, the encoding WebKit uses for some stored values. Expected output: `2`.

   ```sh
   find_marker() {
     find "$1" -type f -exec perl -0777 -ne '
       BEGIN { $m = shift @ARGV; ($u = $m) =~ s/(.)/$1\0/g }
       print "$ARGV\n" if /\Q$m\E/ || /\Q$u\E/' "$2" {} + 2>/dev/null | wc -l
   }
   test=$(mktemp -d)
   printf 'kumquat-lantern' > "$test/plain"
   printf 'kumquat-lantern' | iconv -t UTF-16LE > "$test/wide"
   find_marker "$test" kumquat-lantern
   rm -r "$test"
   ```

3. Count files containing the marker in each place TalkQTE, its webview and macOS may write for it. Record each line (index and count, or "absent"):

   ```sh
   i=0
   for dir in "$HOME/Library/Application Support/com.talkqte.desktop" \
              "$HOME/Library/Caches/com.talkqte.desktop" \
              "$HOME/Library/WebKit/com.talkqte.desktop" \
              "$HOME/Library/HTTPStorages/com.talkqte.desktop" \
              "$HOME/Library/Saved Application State/com.talkqte.desktop.savedState" \
              "$HOME/Library/Logs/DiagnosticReports"; do
     i=$((i + 1))
     if [ -e "$dir" ]; then echo "$i $(find_marker "$dir" kumquat-lantern)"; else echo "$i absent"; fi
   done
   ```

4. Repeat the same loop with `find_marker "$dir" access_token` and again with `find_marker "$dir" refresh_token`, and record the counts. This is a heuristic: it finds the words that usually accompany a token, not the token itself, which TalkQTE never shows.
5. Check the system log since the start time, including the webview's helper processes, which receive note text: replace `START` with the recorded time.

   ```sh
   log show --info --debug --start "START" \
     --predicate 'process CONTAINS[c] "talkqte" OR process BEGINSWITH "com.apple.WebKit"' \
     | grep -c -e kumquat-lantern -e access_token
   ```

   Record the count. macOS often redacts dynamic text in this log, so 0 here is weak evidence on its own.

6. Record whether `$HOME/Library/Application Support/com.talkqte.desktop` exists and, if it does, whether it holds anything other than a `models` folder (yes/no).

**Expected:** every count is 0, and the data folder is absent or holds only `models`. TalkQTE keeps notes and the sign-in in memory only; its own code writes no files other than a downloaded speech model and an export you save. The webview and macOS write their own files, which is what this step checks.

**Pass if** the control prints 2, every count is 0, and the data folder is absent or holds only `models`. **Fail if** the control does not print 2 (the search is not working; do not count the step), any count is above 0 (report the index and which word, not the matching text), or the data folder holds anything else.

**Settles:** P3, "storage and logs of a built app after a real session", for a debug build. A release build (`npm run tauri -- build --bundles app`) disables the webview inspector and may store differently; repeat step 7 with one before relying on this for a release. This step does not cover Granola's own retention or network traffic.

## Steps that need a paid plan

Run these only if the account has the feature, and before step 8; otherwise record "not available on this plan" and leave the related question open. Do not upgrade for this check, and never use a note another person owns.

- **Access change rather than deletion.** Unsharing a note you own, or moving it between folders in one workspace, does not change your own access, so it tests nothing here. Only moving the first throwaway note to another workspace you belong to, or a throwaway note shared to you from a second account you control, does. If possible, make that change, then list and import as in step 3, and record whether the listing still offers the note and the import message. Settles N2, "changed/revoked content", for an access change rather than a deletion.
- **Switching the active workspace.** If the account has more than one workspace: repeat step 6 in each and record whether the identity lines differ (yes/no). Then switch the active workspace in Granola while TalkQTE stays connected, list, and record whether the first throwaway note's presence in the listing changes (yes/no). Settles N2's workspace-binding question: whether an externally changed workspace is visible to the client at all.

Notes older than 30 days cannot be checked with this build on any plan: TalkQTE always asks for the last 30 days.

## 8. Clean up

Delete the remaining throwaway note in Granola, remove all notes in TalkQTE, disconnect, and quit. If Granola's settings list connected apps, revoke only entries named "TalkQTE"; each Connect registers a new entry, so there may be several. Leave any other integration alone.

## Results template

Copy this table into the PR or report that records a run. Fill in only what the column asks for.

| Step | Date run | Build commit | Result (pass / fail / not possible) | Counts, timings and yes/no answers | App messages (fixed text only) | Identity lines (step 6 only) |
| ---- | -------- | ------------ | ----------------------------------- | ---------------------------------- | ------------------------------ | ---------------------------- |
| 1    |          |              |                                     |                                    |                                |                              |
| 2    |          |              |                                     |                                    |                                |                              |
| 3    |          |              |                                     |                                    |                                |                              |
| 4    |          |              |                                     |                                    |                                |                              |
| 5    |          |              |                                     |                                    |                                |                              |
| 6    |          |              |                                     |                                    |                                |                              |
| 7    |          |              |                                     |                                    |                                |                              |
| Paid |          |              |                                     |                                    |                                |                              |

## What a full pass would and would not settle

A full pass on the free plan gives P3 recorded real-account evidence for removal, export exclusion, disconnect and reconnect, and a debug build's storage and logs, and gives N5's first-slice criteria real-account evidence for import, source and date, removal and export. It gives N2 a measured update delay, whether Granola sends update times, Granola's behavior for a deleted note, and a lead or no lead on workspace identity.

It does not establish Granola's retention or network traffic, a release build's storage, behavior on another plan or workspace, native VoiceOver, or whether imported context helps during a conversation. N5 stays open on that last point. P3 also stays open on microphone release on real hardware. N2 stays open unless a workspace identity is found and confirmed, and an update check bound to it is then built and checked on the account.
