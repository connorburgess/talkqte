# Fresh fictional scenarios for lab runs

Status: development tooling, 16 November 2026. `scripts/lab-fresh-scenario.mjs` draws a new fictional meeting brief from a seed, places spoken lines with call-like pacing, checks a rendered mix against what was intended, and defines the manifest that describes the resulting media. The module is offline and deterministic. It does not call a model, speak lines, encode video or change what the lab accepts.

The default lab media remains one prepared fictional recording; the reviewed media loader can also accept a separately approved per-run manifest. This module supplies offline authoring and checking helpers for such a manifest. It generates no conversation or media and grants no playback approval. Fresh fictional scenarios could broaden the cases available for later evaluation, but these helpers establish no coverage of real meetings or useful assistance.

## Briefs

`sampleBrief(seed)` returns the same brief for the same seed (a whole number from 0 to 4,294,967,295). A brief is not a script. It gives a generator sparks to invent from and the structure the conversation must have:

- **Sparks:** one of 50 invented groups, 9 kinds of call, two of 63 everyday objects and one of 8 moods. Every entry is generic, and a test checks that none of them names a company or product on the dialogue lab's deny list.
- **People:** 2 to 4 speakers with distinct fictional first names and distinct preset macOS voices. One of them is the listener the recording follows.
- **Title:** `none` (about 35%), `on-topic` (30%) or `drifted` (35%). A drifted title names what the call was booked for, and the conversation then spends most of its time elsewhere. The brief records only the mode; a title, when there is one, comes from the generated conversation.
- **Structure:** 1 to 3 topic changes and a drift style. The conversation must also contain one ambiguity left open for several turns, one issue the conversation settles itself, and one stretch where saying nothing is right.

Nothing downstream may depend on the title or an agenda. The manifest marks the media as the only runtime input.

## Pacing

`scheduleLines()` takes each line's speaker, beat (`quick`, `normal` or `pause`) and speech length. It places the lines with a lead-in, a gap before each turn and a tail:

| Beat     | Gap before the turn |
| -------- | ------------------- |
| `quick`  | 120–320 ms          |
| `normal` | 380–1050 ms         |
| `pause`  | 1300–2600 ms        |

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
- the media file's absolute path, SHA-256, size in bytes and duration in milliseconds, all whole numbers;
- the verified streams: `video` (`codec` `h264`, `width`, `height`, `fps`) and `audio` (`codec` `aac`, `sampleRate` 48000 in hertz, `channels`);
- the window, plus whether the file fits under the 104 s that the lab's timing bounds were set for (`withinCurrentLabCap`);
- how the conversation was generated: the route (`offline-stand-in`, `codex-subscription` or `anthropic-api`), and optionally the model and the cost in US dollars;
- optionally, the voice renderer (`say` or `deepgram`) with its model, request count, billed characters, cost and the query settings it used, and each speaker's voice;
- optionally, `listener.firstName`: the first name of the person the recording follows, so a lab run can set the app's own "Your name" setting. It must be one of the scheduled speakers;
- pacing statistics, the line schedule and the verification result;
- hashes of the companion files;
- `runtimeInputs: "media-only"`.

A manifest is refused if any of these is true:

- a title is present when its mode forbids one, or missing when its mode needs one;
- the title names a listed real company or product, or contains a web address, email, handle or phone number;
- a size or duration is not a whole number, or a stream is missing or in another format;
- the media is outside the window;
- a schedule row ends after the media does;
- the generation route is unknown, or a cost is negative;
- the renderer is not `say` or `deepgram`, any field in it or in the generation record is named like a credential (key, token, secret, auth, password, credential, bearer), or its query uses a name outside `model`, `encoding`, `container`, `sample_rate`, `bit_rate` and `mip_opt_out` or a value that is not plain;
- a voice is given for someone not in the schedule, or a voice id is not plain;
- `listener` has any field other than `firstName`, or the name is not a capitalised single word of one of the scheduled speakers;
- schedule rows overlap;
- the verification did not pass.

## Content checks

`contentProblems()` and `generatedContentProblems()` apply the dialogue lab's deny list of real companies and products, matched literally as whole words, and its contact-detail pattern. A generator step should run `generatedContentProblems()` over the title and every line, and refuse to write a manifest when it finds anything. The deny list cannot catch every real name. A generator should still be told to invent every name, and a person should still read the conversation.

## Limits

- This module does not decide what the lab plays. The lab's own loader does, with its own checks, and it may be stricter than `validateManifest()`, for example about where files are stored.
- Generating the conversation and rendering voices are not part of this module.
- Credential-shaped field names and non-allowlisted query names are refused; plain metadata strings are not a general secret detector. Keep all credentials out of metadata and review fictional content before any separately approved export.
- A seed fixes the brief and the pacing, not the words a generator writes.
- The brief space is finite, though large.

## Checks

`scripts/lab-fresh-scenario.test.mjs` is part of `npm run test:cue-lab`. It uses a hand-written synthetic conversation (`scripts/fixtures/lab-fresh-scenario-standin.json`), and tones stand in for speech. The tests check:

- **Briefs:** the same seed gives the same brief, and 400 seeds give varied briefs covering 2, 3 and 4 speakers, 1 to 3 topic changes and all three title modes. No brief carries a title or agenda, names and voices are distinct, and the brief space names no listed company or product.
- **Pacing:** a schedule fits the window with no overlap, quick gaps are shorter than normal ones and normal shorter than pauses, and speech too long or too short for the window is refused.
- **Mix check:** a faithful track passes. The check finds sound in a gap, a missing line, a 6 dB level drop, a line starting 90 ms late, a duration outside the window, mismatched lengths and the wrong sample rate.
- **Manifest:** each of these is refused: wrong titles, a title naming a brand or contact detail, wrong media, fractional sizes or durations, missing or wrong streams, overlapping rows, a row ending after the media, wrong generation counts, wrong lab-limit flags and failed checks. Fractional values passed to `buildManifest()` are rounded. Media over 104 s is marked as not fitting the lab cap.
- **Generation and voices:** an `anthropic-api` route with model and cost, a Deepgram renderer and per-speaker voices are accepted and stay optional; an unknown route, a negative cost, any credential-named field, an unlisted or non-plain query parameter, and a voice for someone not in the call are each refused.
- **Listener:** a listener first name from the schedule is accepted and stays optional; a name not in the call, lower case, two words, an extra field, an empty value or a bare string are each refused.
- **Content:** brands and contact details are found in a title or line and reported by line, and list entries are matched literally.

See also the [cue lab batches and simulations](cue-simulation.md).

An offline fixture joins an authored manifest to the real media loader using only
the existing harmless placeholder bytes. It checks manifest hash approval,
listener propagation, refusal of a copied unbranded descriptor and the unchanged
104-second loader cap. It does not decode a codec, regenerate media, select an
artifact, play anything or prove title independence at runtime.
