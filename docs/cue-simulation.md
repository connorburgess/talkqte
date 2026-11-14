# Cue lab batches and simulations

Status: development tooling, 14 November 2026. It extends the [Claude cue lab](claude-cue-lab.md) from one case per invocation to a bounded batch over a bundled fictional set, adds a timing simulation over longer fictional conversations, and can record a simulation as a video. No model run was made for this change; everything recorded here was run offline with a fake evaluator or with the phrase rules' recorded outcomes. Nothing here connects a model to the app.

The tooling exists to learn when a cue should appear, stay away, or leave. It cannot show that a cue helps anyone. Read [what the numbers do not show](#what-the-numbers-do-not-show) before quoting any of them.

## Evaluators

Everything that decides about a cue sits behind one adapter in `scripts/cue-evaluators.mjs`, so another provider (a different CLI, a local model) is one more entry in its list. The adapter itself says what each request carries (`request`), and the dry run, the run and the log all take it from there.

| Evaluator | What it is | Leaves the device |
| --- | --- | --- |
| `claude` | Claude Code with Opus 5.5 through the subscription sign-in, with the isolation described in the [lab page](claude-cue-lab.md#isolation-and-output) | Yes: the fictional case text goes to Anthropic. Hosted inference |
| `fake` | A deterministic keyword stand-in with a made-up delay. It proves the harness. It is not the app's rules and not a model | No |
| `rules` | The phrase rules' recorded final outcome for each case, read from `scripts/fixtures/cue-rules-recorded.json` | No |
| `labels` | Simulation only: the labels themselves, acted on after a fixed delay (`--latency-ms`). It shows a cue at each labelled moment and clears it at the labelled line | No |

The phrase rules run in Rust. The lab does not run them: it reads the outcomes that the engine's replay tests assert, and an offline test fails if that record and the arrays in `engine.rs` ever differ. The record holds one final action per case, with no cited sources, wording or delay. Its `cue-lab` entry is the "from the fixture's cue" measurement in the [rules baseline](cue-intelligence.md#rules-baseline-on-the-shared-suite); the other two are the scores after the rule changes written against those sets.

## Dry run first

Without `--run`, nothing is started and nothing is sent. The dry run prints the set, the number of model requests a run would make, where the text would go, each system prompt, and the exact input of every request:

```sh
npm run lab:batch -- --set cue-lab
npm run lab:batch -- --set held-out
npm run lab:batch -- --set independent --cases gate-shift-taken,tomato-glut
```

The sets are the three bundled fictional files: `cue-lab` (11 cases), `held-out` (23) and `independent` (34). One invocation covers one set; there is no all-sets switch. Labels, case IDs, categories and the rules' cue type are never sent. A case that gives a session name sends it as `userName`, with one added sentence in the system prompt saying whose name it is; every other case is sent exactly the prompt the [recorded trials](claude-cue-lab.md#validation-record) used.

## Offline runs

The fake evaluator and the recorded rule outcomes need no account, model or network:

```sh
npm run lab:batch -- --set independent --evaluator fake --run --out <directory outside the repository>
npm run lab:batch -- --set cue-lab --evaluator rules --run --out <directory outside the repository>
```

`--out` (or the `TALKQTE_LAB_OUTPUT` environment variable) must be an absolute path outside the checkout. The runner refuses a path inside the repository, including through a link or another letter case of the same folder, and writes to the resolved location, so results, logs and recordings cannot be committed by accident.

## A bounded model run

A model run is an explicit, one-off local experiment. It needs the owner's go-ahead for that stated run (which set, how many requests), and the same manual check as before that paid extra usage is off in the Claude account:

```sh
npm run lab:claude -- --check
npm run lab:batch -- --set held-out --run --out <directory outside the repository> --max-calls 23 --included-usage-confirmed
```

What the runner enforces:

- **A call cap.** `--max-calls` is required, from 1 to 100. An evaluator counts as hosted unless its adapter says explicitly that it is not, so a new adapter cannot skip the acknowledgement or the cap by omission. A run that would need more requests than the cap is refused before anything starts, and the loop stops at the cap regardless.
- **No API key, ever.** If the shell carries an API key, auth token, base-URL override or provider switch (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_…` and similar), the run is refused before any process starts and the message names the variables, never their values. The single-case command refuses the same way, and so does a shell with `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` set. The existing checks still apply after that: the child process gets an allowlisted environment, and an API-key, routed or unknown sign-in is rejected before any model request.
- **One version check and one sign-in check, which send no case text, then one request per case, one at a time.** No retry, no alternate model, no fallback.
- **Stop at the first failure.** A usage limit, an error, a reply from another model, or a malformed decision ends the batch. Whatever completed is written, with the reason.
- **Nothing recurring.** There is no schedule and no loop that starts by itself; CI never runs a model.

The acknowledgement flag records the owner's manual check; it cannot enforce the account's spending setting.

## What a run writes

Two files, named with the set, the evaluator and the UTC time, for example `cue-lab-batch-held-out-claude-20261114-093005.json`:

- **Results** (`.json`): for each case the action, the cue text, the cited source IDs, the reason, observed use, latency, whether the action matches the label, the rules' recorded action and whether the evaluator agrees with it; then a summary.
- **Event log** (`.log.jsonl`): one line per event, appended as it happens, so a run that stops early keeps everything up to that point. It holds the run's settings, each system prompt, the exact input of every request, every decision in full, the CLI's own timing counters (total and API time) and token counters, and the reason for stopping.

The log deliberately leaves out the CLI's raw output, session IDs, account identity and credentials. Both files are private working files. Only a reviewed, fictional summary may later be added to these docs.

## Reading the summary

| Field | Meaning |
| --- | --- |
| `label` | Cases where the evaluator's action is the one the case's author expected |
| `byExpectedAction` | The same, split by the expected action |
| `quietLabelled`, `quietKept` | Cases labelled quiet, and how many of them the evaluator left quiet |
| `actedWhenLabelledQuiet` | Unwanted actions by the labels: a cue shown, or a cue removed, where the label says nothing should change |
| `neededAction` | Cases whose label needs an action (show, resolved, withdraw), and how many matched |
| `agreesWithRules` | Cases where the evaluator and the phrase rules chose the same final action |
| `rulesMatchLabel` | The phrase rules' own score on the same cases |
| `latency` | Minimum, median, 95th percentile (nearest rank) and maximum request time, and how many exceeded the 5-second [trigger-to-cue budget](budgets.md) |
| `usage` | Token counters summed as the CLI reported them |

Always read `label` beside `quietLabelled`: a companion that never did anything would match every quiet label (14 of 23 held-out, 17 of 34 independent).

## What the three case sets cover, and what they leave out

`npm run lab:sim -- --coverage` prints this from the fixtures; nothing is started.

| Material | Items | Lines | Lines each | Median words a line | Times | Labels |
| --- | --- | --- | --- | --- | --- | --- |
| `cue-lab` | 11 | 24 | 2 to 3 | 8 | none | show 2, quiet 5, resolved 2, withdraw 2 |
| `held-out` | 23 | 37 | 1 to 2 | 9 | none | show 4, quiet 14, resolved 1, withdraw 4 |
| `independent` | 34 | 63 | 1 to 3 | 11 | none | show 7, quiet 17, resolved 6, withdraw 4 |

Read together, the 68 cases are good at one thing: a single decision about a single moment, with the phrasing varied. They leave out most of what decides whether a cue arrives in time:

- **No time.** No case has timestamps; the replay spaces lines two seconds apart. Nothing can be late.
- **No length.** No case is longer than three lines and 19 are one line, so nothing exercises the six-line window, a cue expiring, a second cue, or a cue being taken back.
- **One moment each.** There is no backchannel, no housekeeping, no question answered in the same breath around the moment, so staying quiet through ordinary talk is barely tested.
- **One kind of setting.** The talk is about halls, stalls, checklists and office moves. No case is about software, AI work or hiring: across all 124 lines "deploy", "model", "interview", "candidate", "release" and "bug" never appear.
- **Speakers.** Only the first set names a speaker role; the other two have one label, as a live transcript does today.

## Timed conversations

`scripts/fixtures/cue-sim-conversations.json` adds 13 fictional conversations of 11 to 15 lines (168 lines, 69 to 128 seconds each) for people who work in software, AI and hiring:

| Context | Conversations |
| --- | --- |
| Engineering | a stand-up, an incident review, sprint planning, a new-starter setup call |
| AI | a model evaluation review, a rollout decision for a support assistant, a paper reading group |
| Interviews and hiring | a system design interview (the listener is the candidate), a panel debrief, a role intake with a recruiter |
| Customer | a technical call with a prospective customer |
| Product | a design review |
| One-to-one | a weekly one-to-one with a manager |

Each line has the time its speaker finishes it, and a label for what should happen once it has been heard:

- `quiet` (113 lines): nothing should change. These include backchannels, tag questions, questions answered in the same breath, housekeeping about screens and sound, text dictated or read aloud, names mentioned but not addressed, jokes shaped like a task, and "we could" brainstorming.
- `show` (30): a cue about this line would help, with what it is about and, for 17 of them, `until`: the line after which it no longer would. The moments are a task nobody takes, a vague deadline, a question put to the listener by name, a question in several parts with one part left unanswered, a number that changes when it is repeated, a concern that is put off, and constraints said once.
- `resolved` (13) and `withdraw` (2): this line answers, or removes the basis of, an earlier labelled moment.
- unlabelled (10): the line could defensibly go either way, and a note says why. These are not scored.

The labels were written by the lab lane before any evaluator was run on the conversations, and **await the owner's review**. The fixture records what its author had read. Line lengths, pauses, backchannels and restatements were written to resemble a live transcript rather than tidy dialogue; they are still invented, and cleaner than real speech: there is no overlap, no mis-heard word and no merged speaker.

Some labelled moments are short on purpose. A question put to someone by name is usually answered within seconds, so a cue for it can only be late; the simulation should show that, not hide it.

## Timing simulation

The simulation replays a conversation on a virtual clock and asks the evaluator, each time a line arrives, what to do given only the lines so far:

```sh
npm run lab:sim                                   # dry run over all 13 conversations
npm run lab:sim -- --conversations standup-flaky-test,model-eval-review
npm run lab:sim -- --evaluator fake --run --out <directory outside the repository>
npm run lab:sim -- --set cue-lab --evaluator rules --run --out <directory outside the repository>
```

What it does, following the app's [evaluator bridge](cue-evaluator.md#transcript-lifecycle-bridge) where one exists:

- A line reaches the evaluator a fixed time after it is said (`--transcript-delay-ms`, 3,000 by default, standing in for local transcription).
- Each request holds the newest six lines and the lines the cue on screen cites. With `--input app` (the default) every line has the one label "Speaker" and no name is sent, as the app would send today; `--input named` adds speaker names and the listener's name, to see what they change.
- One request at a time. A line that arrives while a request is in flight overtakes it: that decision is dropped, and one catch-up request follows with the latest lines. `--apply-stale` applies overtaken decisions anyway, to see how late they would have been.
- Evaluations start only on a new line and at least `--min-gap-ms` apart (2,000 by default), so a conversation of N lines makes at most N requests. The dry run prints that bound for each conversation, and every line as a request would carry it.
- One cue at a time. An unread cue lives 18 seconds from its newest cited line; a cue proposed later than that is refused.

It does not simulate cooldown, focus, hold, dismissal, note reminders or the companion window. A model run needs the same flags as a batch (`--run`, `--included-usage-confirmed`, `--max-calls`, an output directory) and the owner's go-ahead for that stated run; it is refused if it could need more requests than the cap, and stops at the first failure. Conversations that finished are written to the results file; the one in progress when a run stops is only in the event log. Each request carries up to six recent lines, the lines the cue on screen cites, and that cue's text, so a cue the model wrote is sent back to it.

With `--set`, each case of a set is replayed as a two-second conversation from the fixture's own cue. The phrase rules can be used there (`--evaluator rules`), but only as their recorded final outcome applied at the last line. **The rules have not been replayed on the timed conversations**: they run in Rust, and that needs an engine replay that records each line.

### What each number means

| Number | Meaning |
| --- | --- |
| Evaluations: started, applied, overtaken | Requests made; decisions that took effect; decisions dropped because a newer line arrived first |
| Labelled moments: in time, late, missed | Of the `show` labels: a cue was on screen before the moment closed; after it closed; or never. A cue belongs to the latest moment still open when its request was made |
| Line said to cue on screen | From the end of the labelled line to the cue appearing: transcription delay, any wait, and the decision. This is the number the 5-second [budget](budgets.md) is about |
| Decision time | The evaluator's own time per request |
| Unexpected cues | Cues shown that belong to no open labelled moment |
| Flips | Cues the evaluator showed and then withdrew when no line heard by then was labelled as a reason to withdraw that cue |
| Duplicates | A second cue for a moment already cued, or the same words shown again |
| Quiet kept | Of the evaluated lines labelled quiet, those where the decision was quiet, whether or not that decision was later dropped. A decision that is only catching up (a cue for a moment still open, or clearing a cue after the line labelled as ending it) is not counted against quiet |
| Endings: as labelled, otherwise, lingered | When a line answers or removes the basis of a cue on screen: cleared with the labelled action, cleared with the other one, or left until it expired, with how long it stayed |

### What replaying the labels shows

The `labels` evaluator answers one question without any model: if an evaluator agreed with every label and took a fixed time to decide, which cues would still be on time? It sees only what a request holds, so it cannot cue a moment that has left the six-line window.

```sh
npm run lab:sim -- --evaluator labels --latency-ms 4000 --run --out <directory outside the repository>
```

Run offline on 14 November 2026 over all 13 conversations (30 labelled moments), with a line reaching the evaluator 3 seconds after it is said:

| Decision time | Cue in time | Late | Missed | Line said to cue on screen, median | Over the 5-second budget |
| --- | --- | --- | --- | --- | --- |
| 0 s | 28 | 0 | 2 | 3.0 s | 2 of 28 |
| 2 s | 28 | 0 | 2 | 5.0 s | 6 of 28 |
| 4 s | 24 | 4 | 2 | 7.0 s | 28 of 28 |
| 6 s | 16 | 8 | 6 | 9.7 s | 24 of 24 |

With no transcription delay and a 4-second decision, 28 are in time and 9 of 28 are over the budget.

What this does and does not say:

- It is arithmetic on invented conversations and on the lane's own labels, with two assumed delays. It is not a measurement of any model or of the app.
- It is a ceiling, not a forecast: a real evaluator will disagree with some labels, and its decision time varies.
- The two moments missed even at 0 s open while an earlier cue still holds the single slot.
- At 4 seconds, about the middle of the [recorded request times](claude-cue-lab.md#validation-record), every cue is over the 5-second budget because the transcription delay alone uses 3 of the 5 seconds, and the moments lost first are the short ones: a question put to someone by name, which the conversation answers within seconds.
- "In time" here means before the line that ends the moment has been said, or within the 18 seconds a cue may live. It does not mean the cue would have helped.

### What an offline run shows

Run offline on 14 November 2026 with the fake evaluator and default settings, all 13 conversations: 168 evaluations, 41 of them overtaken and dropped, and the two cues it showed appeared a median 6.8 seconds after their line was said. Those figures say nothing about cues: the fake matches keywords and its delay is made up. They show that the harness counts, drops, places and scores as described. One thing in them is real arithmetic, though: a 3-second transcription delay plus any decision slower than 2 seconds is over the 5-second budget before the companion draws anything.

## Recording a simulation

A results file from the simulation can be played back as a video, to watch how and when cue cards appear. The recorder asks no evaluator anything: every decision comes from the file, whether that was written by the fake, the labels, the rules, or an approved model run.

```sh
npm run dev -- --port <port>                       # the browser preview, in another terminal
npm run lab:record -- --results <cue-sim results .json> --url http://127.0.0.1:<port> --out <directory outside the repository>
npm run lab:record -- --results <file> --url <url> --out <directory> --conversations model-eval-review --with-notebook
```

What is on screen:

- **The real companion**, drawn large, is the subject: the cue card can be read at a glance. It is the app's own companion window at its own size, scaled up, running in the browser preview and fed the simulated session through the same stand-in the browser tests use. The session is a scripted one, not a live one, so the app says so in its own words ("Demo running · Scripted", "Demo question") and never claims a microphone.
- **A mock video call** is quiet background: invented participants as tiles, the current speaker, and captions. It stands in for a meeting app and is labelled "Mock call. Not a real meeting or meeting app."
- **A small label across the top** for the whole recording: "Simulated", "Fictional", "No model" or "Real model decisions" (with "run stopped early" when it did), "Synthetic voices" when the lines are spoken, the conversation, where the cue decisions came from, and what the decision times are (measured, recorded with none, or made up).
- **A small lab overlay**, marked as not part of TalkQTE, listing each time the evaluator was asked and what it decided, including decisions that were dropped.

The notebook is not in the main video. `--with-notebook` writes a second video of the real notebook by itself, kept scrolled to the newest transcript line, where lines arrive when the results say they reached the app under the one "Speaker" label a live transcript has today. The notebook's own wording describes the app as it is today (phrase rules, no model connected); the label says where the decisions actually came from.

**Sound.** At normal speed the fictional lines are spoken aloud behind the card, and "Synthetic voices" is shown for the whole recording. By default the speech is made on this device, offline, with macOS `say` and installed system voices, one per speaker; no speech service is used. Each line's clip is placed so that it **ends when the simulation says the line ends**, which is the moment every cue decision is timed from, and is mixed into the MP4 as AAC. Nothing in the simulation is moved to fit the speech: a clip that cannot fit after the previous speaker ends late, and the manifest lists it with by how much. Without `say` the recorder uses plain test tones if `ffmpeg` is there (labelled "Test tones"), and without `ffmpeg`, or with `--no-sound` or another `--speed`, the video is silent.

**More natural voices, as a separate optional step.** `npm run lab:voices` makes the clips with a hosted text-to-speech service instead (OpenAI's `gpt-4o-mini-tts`, the provider's preset voices, one per speaker, with a short instruction for a conversational manner; nothing is cloned) and caches them outside the repository; `--voices-cache <directory>` then makes the recorder use them when the cache holds a clip for every line.

```sh
npm run lab:voices -- --conversations standup-flaky-test --cache <directory outside the repository>
npm run lab:voices -- --conversations standup-flaky-test --cache <directory> --run --max-chars 1000 --env-file <private dotenv file>
npm run lab:record -- --results <file> --url <url> --out <directory> --voices-cache <directory>
```

- Without `--run` nothing is sent: it lists every line, its voice, how many characters are new and a rough cost.
- A run sends only the lines of bundled fictional conversations, with a voice name and speaking instructions, to that provider. It is hosted and separately billed, so it needs its owner's explicit decision; it is never needed, and CI and the recorder work without it.
- It needs `--max-chars` (at most 20,000), is refused if the new text exceeds it, stops at the first failed request, and does not retry.
- A clip is named by its model, voice, instructions and words, so the same line is never bought twice.
- The key is read from `--env-file` or `OPENAI_API_KEY` by this process only. It is never printed, logged, or passed on a command line, and this step shares no process or environment with the cue lab's model runs, whose refusal of inherited credentials is unchanged.

The recorder finds each cue by its words, not by how the card is built, so it works with the current card and with a redesigned one: it waits for the cue's text to appear in the companion, takes a still, and waits for it to go when the results clear it.

What is saved, in the output directory:

- one video per conversation, re-encoded with `ffmpeg` to a compact MP4 when `ffmpeg` is installed (the raw capture is then deleted; without `ffmpeg` the raw WebM is kept), and a `-notebook` video when asked for;
- a still for each cue and one at the end;
- a manifest (`.json`) with the commit of the checkout the take shows (and any commits named with `--includes`, such as an unmerged card design it was recorded with), the source of the decisions, the settings, the voices used and any clip that ran over, and for each cue when the results expected it and when it was actually seen;
- an event log (`.log.jsonl`).

Limits the recorder enforces:

- **Only bundled fictional conversations.** Every line, speaker, title and participant in the results file must match the bundled fixture it names (a run that stopped may hold fewer lines); anything else is refused before a browser starts. Results not marked fictional are refused.
- **Only the preview on this device.** `--url` must be `http://127.0.0.1`, `http://localhost` or `http://[::1]`.
- **Only outside the checkout.** The output directory is checked wherever the recorder is called from. File names are built from the conversation and evaluator names with anything but letters, digits, hyphens and underscores replaced.
- **A failed take is deleted.** If an expected cue never appeared, or playback failed, nothing is kept.

Recordings are private working files: videos or stills of the app never go in the repository, the README, the website or anything promotional.

A recording shows timing and appearance on invented conversations. Playback runs on the browser's clock, so a cue is drawn a little after the time in the results; the manifest records both. It is not a recording of the desktop app, a real call, real voices, or anyone's use of TalkQTE, however natural the synthetic voices sound.

## What the numbers do not show

- **The cases are fictional.** Sixty-eight short cases and thirteen invented conversations give no rate for real meetings.
- **Label agreement is not usefulness.** A match means the evaluator chose what the author of the case expected. The labels were written by the lanes, not observed in meetings, and await the owner's review. One label in the first set is already disputed.
- **Nothing here is evidence of participation or comprehension.** Whether a cue helps someone stay grounded and respond is the question for the [comparison study](comparison-study.md), with people.
- **Agreement with the rules is not correctness.** Both can be wrong together, and the rules were tuned on two of the three sets.
- **Batch latency is not cue latency.** It is one isolated request including CLI start-up, with no transcription delay, no other speech arriving, and no window to draw.
- **Simulated timing is not measured timing.** The clock is virtual, the transcription delay is one fixed number, and a model's decision is placed using the time of an isolated request. It can show that a design cannot be on time; it cannot show that one is.
- **A moment labelled `show` is the author's opinion that a cue would help.** Whether it would is exactly what has not been tested.
- **The fake evaluator's scores mean nothing.** They exist so that the harness, the files and the summary can be checked before any model is involved.

## Checks

`npm run test:cue-lab` runs the offline tests for the single-case lab, the batch runner and the simulation. For the batch runner they cover: the dry run starting nothing; every refusal above happening before any process; one sign-in check and one request per case; stopping at the first limit, error, wrong model or malformed reply without retry; the call cap; labels never reaching the evaluator; the first set's prompt being unchanged; the rules record matching the engine's tests; results being refused inside the checkout; and the fake evaluator being repeatable. CI runs them with no model, credentials or network.

For the simulation they cover: a cue appearing one decision after its line and being scored against its moment; an overtaken decision being dropped with one catch-up; never two requests at once; the minimum gap and the dry-run bound; expiry after 18 seconds; the six-line window and what an app-style request contains; each count in the table above on a small scripted conversation; the labels evaluator acting only where a label says to and losing moments as its delay grows; stopping at the cap and at the first failure with the log intact; every refusal happening before any process; repeatability; and the shape of the conversation fixture.

`scripts/cue-sim-voices.test.mjs` (part of `npm run test:cue-lab`) checks the voice step against a stand-in provider: nothing sent without `--run`; the cap, the key and a bundled conversation required; only the lines, a voice and instructions sent; each clip cached and not bought again; the key absent from every output and log; and the first failure ending the run.

The recorder's browser test (`tests/lab-recording.spec.ts`, Chromium and WebKit) is opt-in, `npm run test:lab-record`, and is not part of `npm test` or CI because it records video; it writes only to a temporary directory outside the repository. It records a three-line fictional conversation from a results file, with test tones for speech, and checks: one video with a sound track and no raw capture left; the cue seen in the companion by its words and seen to leave; no notebook in the main view and a second video only with `--with-notebook`; the on-screen labels; a take that cannot show its cue being deleted; a folder inside the checkout being refused; and the command refusing other hosts and anything but the bundled conversations.
