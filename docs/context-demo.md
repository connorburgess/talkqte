# Context demo: authored cues and phrase timing (browser preview)

A second way to play the fictional community-garden demo ("A better welcome"), for the two open items under Next product validation in the [roadmap](../ROADMAP.md). It runs only in the browser preview, at `http://127.0.0.1:1420/?demo=context`. Without that address the demo is unchanged, and the desktop app does not have this run yet (see [What is not done](#what-is-not-done)).

Everything in it is fictional and written by hand. No model chooses the cues or the notes, nothing is captured, and live sessions never read these files.

## What it does

- **Prior notes are already selected.** Two fictional notes, each titled "(fictional demo)", are listed under **Prior context** when the page opens and can be removed there. They come from [`src/demo-context.json`](../src/demo-context.json), not from a file or an account.
- **The transcript arrives in phrases.** Each of the script's 21 phrases appears half a second after its last word is spoken, so a long turn builds up piece by piece.
- **A cue follows the phrase that prompts it.** Three authored cues each cite the spoken phrase and the note they draw on. The first appears while its speaker is still talking. Select the source line under a cue to read both sources; the phrase is labeled as this conversation, the note as a prior note.
- **The phrase rules are off for this run.** There is no owner or timing question, no word-for-word quote card, and no imported-note reminder.

| Time | Cue                                                 | Triggering phrase                              | Note cited               |
| ---- | --------------------------------------------------- | ---------------------------------------------- | ------------------------ |
| 0:07 | Sam offered to draft this on 28 Oct                 | "Someone can take the first draft"             | Garden committee, 28 Oct |
| 0:37 | Next visitor group: Sat 22 Nov                      | "before the next group of visitors arrives."   | Visitor schedule, 3 Nov  |
| 0:56 | A gate sign needs council approval, about two weeks | "or put a small sign with a link by the gate." | Garden committee, 28 Oct |

## Cue rules in this run

The run has its own timing, written in the `lifecycle` block of the fixture: a cue stays **12 seconds** and is followed by a **5-second** pause. The live rules (18 seconds, then 10) would hide the third cue, because it comes 19 seconds after the second. This is a choice for a 63-second script, not a proposal for live sessions. The **Quiet** timing setting still applies its 30-second pause, which hides the second cue.

Each opportunity is considered once, when its phrase arrives:

- It is skipped if a cue is on screen, including one being read. A cue on screen is never replaced.
- It is skipped during the pause after a cue.
- It is skipped if a note it cites has been removed.
- A skipped opportunity is not kept for later.

Removing a note withdraws a cue that cites it, even one being read. Removed notes stay removed when the demo is replayed; reloading the page brings them back. Replay starts again from the first opportunity.

The bundled notes carry `demo:` identifiers and are held apart from imported notes. An imported note cannot stand in for a removed bundled note, and **Remove all** clears both kinds.

## Phrase timings

[`src/demo-phrases.json`](../src/demo-phrases.json) holds each phrase's wording, the start and end of its speech in the bundled clip, and one `deliveryDelayMs` (500) added to the end to get its arrival time. The wording is written by hand; the times are produced by a script:

```sh
node scripts/demo-phrases.mjs          # rewrite the timings
node scripts/demo-phrases.mjs --check  # fail if they no longer match the clip
```

It needs `ffmpeg` and runs no speech recognition. ffmpeg's `silencedetect` filter lists every stretch of the clip quieter than −35 dB for at least 0.12 seconds. A turn's speech runs from the end of the silence before it to the start of the silence after it. Inside a turn, each phrase break is matched to one detected pause.

How accurate this is:

- **Pause positions** are measured to within a few hundredths of a second.
- **Which words sit either side of a pause is inferred, not heard.** In all seven turns the number of detected pauses equals the number of phrase breaks, so each break took the one pause available. Ten of the fourteen breaks are at a comma or full stop. Four are not ("first draft / of the welcome guide", "by Friday / and try it", "print the guide / or put a small sign", "next garden meeting / and hear"), and two of those rest on pauses of only 0.13 to 0.14 seconds ("first draft / of" and "by Friday / and"). An even-pace estimate from letter counts lands within 0.53 seconds of every matched pause, which is consistent with the matching but does not prove it.
- **Nobody has listened to check it**, and no transcription with word times was run. If a break is wrong, a phrase would show a few words early or late. A cue cannot appear before its phrase is shown.
- **Turn ends are earlier than the whole-line demo shows.** Speech ends 0.1 to 0.8 seconds before the line times in `src/demo.json`.

Against live transcription: measured from the start of a phrase, text appears 0.9 to 3.3 seconds later. The [measured live delay](local-transcription.md) with pause-based chunks is a median of 3.1 seconds and at most 3.7, so the demo stays inside the live maximum but is quicker than a typical live line on short phrases. The preview updates five times a second, which adds up to 0.2 seconds.

## If the audio is regenerated

1. Update `src/demo-voices.json` turn times for the new clip, as before.
2. Run `node scripts/demo-phrases.mjs`. If a turn's pauses no longer match its phrase breaks, the breaks it could not match are marked `estimated`; re-split that turn's wording at the new pauses.
3. Run `npm run test:demo-context`. It fails if a phrase would take longer than the live maximum, or if the stated timing no longer shows all three cues in an untouched run. Adjust the phrase splits or the `lifecycle` values.
4. If the script's wording changes, re-check each opportunity's `phraseId` and each note quotation.

The browser tests read their times from the fixtures and need no edits for new timings alone.

## Checks

- `npm run test:demo-context`: notes support each cue's quotation, phrases spell out the script in order and inside their turns, arrival is after the last word and inside the live maximum, the stated timing shows three cues, and the timing script matches breaks to pauses.
- `tests/demo-context.spec.ts`, Chromium and WebKit: notes selected and removable, phrase arrival, a mid-turn cue never before its phrase, sources under the cue, a held cue not replaced, Pause and Resume, Dismiss, skipped opportunities not queued, Replay, removed notes, separation from imported notes, the Quiet setting, export, and the unchanged default demo.

## What is not done

- **The desktop app.** Its demo is played by the Rust engine from `src/demo.json`, whole lines with phrase rules. This run needs the same data and rules in the engine before it can be the default anywhere.
- **Making it the default in the preview.** The existing browser tests describe the phrase-rule demo and would need rewriting with that switch.
- **Labels.** The cue and the notes panel describe a bundled note as "Imported file" and "From a file", because those are the only note origins the interface knows. The titles say "(fictional demo)" to compensate; a proper label needs a change to the shared note type and both components.
- **Listening.** Phrase breaks, the feel of the half-second delay, the 12 and 5 second timing, and whether the cues help are all unjudged by a person.
