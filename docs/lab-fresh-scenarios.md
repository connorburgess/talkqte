# Fresh fictional scenarios for lab runs

Status: development tooling, 16 November 2026. `scripts/lab-fresh-scenario.mjs` draws a new fictional meeting brief from a seed, places spoken lines with call-like pacing, checks a rendered mix against what was intended, and defines the manifest that describes the resulting media. The module is offline and deterministic. It does not call a model, speak lines, encode video or change what the lab accepts.

Lab runs currently replay one prepared fictional recording. A product that hears real meetings must cope with any topic, any number of people, a title or none, and conversation that drifts. Replaying one file cannot test that. This module is the reviewed basis for giving each run a freshly generated scenario instead.

## Briefs

`sampleBrief(seed)` returns the same brief for the same seed (a whole number from 0 to 4,294,967,295). A brief is not a script. It gives a generator sparks to invent from and the structure the conversation must have:

- **Sparks:** one of 50 invented groups, 9 kinds of call, two of 63 everyday objects and one of 8 moods. Every entry is generic, and a test checks that none of them names a company or product on the dialogue lab's deny list.
- **People:** 2 to 4 speakers with distinct fictional first names and distinct preset macOS voices. One of them is the listener the recording follows.
- **Title:** `none` (about 35%), `on-topic` (30%) or `drifted` (35%). A drifted title names what the call was booked for, and the conversation then spends most of its time elsewhere. The brief records only the mode; a title, when there is one, comes from the generated conversation.
- **Structure:** 1 to 3 topic changes and a drift style. The conversation must also contain one ambiguity left open for several turns, one issue the conversation settles itself, and one stretch where saying nothing is right.

Nothing downstream may depend on the title or an agenda. The manifest marks the media as the only runtime input.

## Pacing

`scheduleLines()` takes each line's speaker, beat (`quick`, `normal` or `pause`) and speech length. It places the lines with a lead-in, a gap before each turn and a tail:

| Beat | Gap before the turn |
| --- | --- |
| `quick` | 120–320 ms |
| `normal` | 380–1050 ms |
| `pause` | 1300–2600 ms |

A speaker who continues after their own line waits at least 450 ms. The gaps are then scaled together so the total falls inside the window, which defaults to 90–104 s and must lie within 60–120 s. If the gaps would need scaling below 0.6× or above 2.2×, the schedule is refused rather than squeezed or padded. Lines never overlap.

## Mix check

`verifyMix()` compares the decoded track of the rendered file with the mix that was intended. It fails when any of these is true:

- a line is missing, or its level differs from the intended mix by more than 2 dB;
- a line starts more than 60 ms off its scheduled place;
- there is sound (above −55 dBFS) inside any gap of 240 ms or more;
- the file is outside the window;
- the container and audio track lengths differ by more than 100 ms;
- the streams are not 1280×800 H.264 video and 48 kHz AAC audio.

## Manifest

`buildManifest()` and `validateManifest()` define `talkqte.fresh-scenario.media.v1`:

- the scenario ID, seed, brief ID, title mode and title;
- how the conversation was generated;
- the media file's absolute path, SHA-256, size and duration;
- the window, plus whether the file fits under the lab player's current 105 s limit;
- pacing statistics, the line schedule and the verification result;
- hashes of the companion files;
- `runtimeInputs: "media-only"`.

A manifest is refused if any of these is true:

- a title is present when its mode forbids one, or missing when its mode needs one;
- the media is outside the window;
- schedule rows overlap;
- the verification did not pass.

## Limits

- The lab's media acceptance is unchanged. Its runner and player still accept one specific prepared recording. Accepting a manifest instead is separate work.
- Generating the conversation and rendering voices are not part of this module. Neither is the content check applied to generated speech.
- A seed fixes the brief and the pacing, not the words a generator writes.
- The brief space is finite, though large.

## Checks

`scripts/lab-fresh-scenario.test.mjs` is part of `npm run test:cue-lab`. It uses a hand-written synthetic conversation (`scripts/fixtures/lab-fresh-scenario-standin.json`), and tones stand in for speech. The tests check:

- **Briefs:** the same seed gives the same brief, and 400 seeds give varied briefs covering 2, 3 and 4 speakers, 1 to 3 topic changes and all three title modes. No brief carries a title or agenda, names and voices are distinct, and the brief space names no listed company or product.
- **Pacing:** a schedule fits the window with no overlap, quick gaps are shorter than normal ones and normal shorter than pauses, and speech too long or too short for the window is refused.
- **Mix check:** a faithful track passes. The check finds sound in a gap, a missing line, a 6 dB level drop, a line starting 90 ms late, a duration outside the window, mismatched lengths and the wrong sample rate.
- **Manifest:** wrong titles, media, schedules, generation counts, lab-limit flags and failed checks are each refused.

See also the [cue lab batches and simulations](cue-simulation.md).
