# Cue lab batches and simulations

Status: development tooling, 14 November 2026. It extends the [Claude cue lab](claude-cue-lab.md) from one case per invocation to a bounded batch over a bundled fictional set, adds a timing simulation over longer fictional conversations, and can record a simulation as a video. No model run was made for this change; everything recorded here was run offline with a fake evaluator or with the phrase rules' recorded outcomes. Nothing here connects a model to the app.

The tooling exists to learn when a cue should appear, stay away, or leave. It cannot show that a cue helps anyone. Read [what the numbers do not show](#what-the-numbers-do-not-show) before quoting any of them.

## Evaluators

Everything that decides about a cue sits behind one adapter in `scripts/cue-evaluators.mjs`, so another provider (a different CLI, a local model) is one more entry in its list. The adapter itself says what each request carries (`request`), and the dry run, the run and the log all take it from there.

| Evaluator | What it is | Leaves the device |
| --- | --- | --- |
| `claude` | Claude Code through the subscription sign-in, with Opus 5.5 or, with `--model haiku-5.5`, Haiku 5.5, with the isolation described in the [lab page](claude-cue-lab.md#isolation-and-output) | Yes: the fictional case text goes to Anthropic. Hosted inference |
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

- **A named model.** `--model opus-5.5` (the default) or `--model haiku-5.5`; nothing else is accepted, so a mistyped name cannot reach another model. The run requests exactly that model with no fallback, and a reply reported as coming from any other model is rejected and ends the run. The model is recorded in the results (`evaluator.model`), in the names of the results and log files, and in a recording's label. A log from one model cannot be used to resume a run of another.
- **A named effort and reply.** `--effort medium` (the default) or `low`, and `--reply full` (the default) or `compact`. The compact reply is the three fields the app acts on (`action`, `cue`, `sourceIds`) with no reason or observed-use label, asked for by a shorter system prompt that says not to explain; it is checked as strictly as the full one. Both choices are recorded in the results and are part of the run's name, so runs under different settings are never taken for one another and one cannot resume another.
- **A call cap.** `--max-calls` is required, from 1 to 100. An evaluator counts as hosted unless its adapter says explicitly that it is not, so a new adapter cannot skip the acknowledgement or the cap by omission. A run that would need more requests than the cap is refused before anything starts, and the loop stops at the cap regardless.
- **No API key, ever.** If the shell carries an API key, auth token, base-URL override or provider switch (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_…` and similar), the run is refused before any process starts and the message names the variables, never their values. The single-case command refuses the same way, and so does a shell with `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` set. The existing checks still apply after that: the child process gets an allowlisted environment, and an API-key, routed or unknown sign-in is rejected before any model request.
- **One version check and one sign-in check, which send no case text, then one request per case, one at a time.** No retry, no alternate model, no fallback.
- **Stop at the first failure.** A usage limit, an error, a reply from another model, or a malformed decision ends the batch. Whatever completed is written, with the reason, the CLI's exit code, and the kind of failure: a usage or rate limit, sign-in or authorization, a network or service problem, the lab's own time or output limit, or not recognized. The kind is read from the CLI's output at the moment it fails; the output itself is never stored, logged or shown.
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
- `show` (30): a cue about this line would help, with what it is about, a wording of at most ten words short enough for a card, and, for 17 of them, `until`: the line after which it no longer would. The moments are a task nobody takes, a vague deadline, a question put to the listener by name, a question in several parts with one part left unanswered, a number that changes when it is repeated, a concern that is put off, and constraints said once.
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
- Each request holds the newest six lines, the lines the cue on screen cites, the listener's name where the conversation has one, and up to four cues this session has already shown with how each ended. Every line has the one label "Speaker", as a live transcript has today; `--input named` adds speaker names, to see what they change.
- One request at a time. A line that arrives while a request is in flight overtakes it: that decision is dropped, and one catch-up request follows with the latest lines. A bare acknowledgement does not (see below). `--apply-stale` applies overtaken decisions anyway, to see how late they would have been.
- Evaluations start only on a new line and at least `--min-gap-ms` apart (2,000 by default), so a conversation of N lines makes at most N requests. The dry run prints that bound for each conversation, and every line as a request would carry it.
- One cue at a time. An unread cue lives 18 seconds from its newest cited line; a cue proposed later than that is refused.

**Cues a glance can read.** A cue here goes on a card that someone reads while listening, so the simulation's prompt adds one rule to the lab's: a cue is at most ten words, one plain question or reminder, with no preamble, list or quotation. `--prompt recorded` uses the recorded trials' prompt unchanged instead; the batch runner keeps that prompt by default and takes `--prompt glance`. The rule is a request, not a filter: a longer cue is still shown, and counted (`cuesOverGlance`, `longestCueWords`). In the first model run, made before this rule, the three cues the model wrote were 24, 20 and 25 words. What the rule does to a model's decisions cannot be known offline; on the offline evaluators it changes nothing, because they do not read the prompt.

**Resuming a stopped run.** `--resume <event log of the earlier run>` reuses the decisions that run completed, so they are not asked for again. A decision is reused only for a request with the identical prompt and input, from the same evaluator; reused decisions keep their measured times, are marked in the timeline, and do not count against the call cap. Because the simulation is deterministic, a run that stopped after N decisions resumes with those N and makes its first new request where the earlier one failed. A log made under another prompt reuses nothing.

**Three changes the first model run asked for.** The review of that run found a good cue thrown away by "Mm." and "Yeah.", a cue proposed again straight after it was withdrawn, and a question to the listener by name that could not be recognised. The simulation now does three things the app's evaluator bridge does not do today. Each is a proposal being tried here, can be switched off to compare, and is recorded in the results' settings:

- **A bare acknowledgement is set aside** (`--overtake-backchannels` restores the old behaviour). A line of one to three words, each from a short list ("mm", "mm-hm", "yeah", "right", "okay", "sure", "exactly", "oh", "ah", "ha" and a few more), that is not a question and does not follow one, starts no evaluation and does not overtake a decision in flight. "Yeah, I'll do it", "Right?", "Okay, next item" and "Yeah." in answer to "Are we done?" are ordinary lines. The rule is narrow on purpose: a line wrongly taken for an acknowledgement would delay a decision about real speech. Later requests still hold the acknowledgement among their lines. Five of the 168 bundled lines are set aside this way.
- **The request lists earlier cues** (`--no-cue-history`). Beside `events` and `existingCue` it gains `earlierCues`: up to four cues this session has shown, oldest first, each as its text and how it ended (`resolved`, `withdrawn` or `expired`). The field is present only when there is something to list, and the system prompt then gains one sentence: do not show a cue that repeats or rewords one of them unless later events give a new reason. A cue that was decided but never shown is not listed.
- **The listener's name is sent** (`--no-listener-name`) as `userName` where the conversation has a listener, the way the app's session name works, with the one sentence in the system prompt that says whose name it is. Lines keep the single "Speaker" label.

What these do to a model's decisions is not known; no model was run. Offline they change only what the harness can show: with a 4-second decision, the labels evaluator cues 25 of 30 moments in time instead of 24, and five fewer requests are made.

**Decisions that newer speech overtook.** In the two-model run of 14 November 2026, 17 of each model's 38 decisions were dropped because a new line arrived first. `--keep-overtaken-cues` (off by default) keeps one kind of overtaken decision: a cue, when nothing is on screen and every line it cites is still among the newest six. `npm run lab:sim -- --replay <results .json>` looks back at a recorded run under each policy with no new request, giving the recorded decisions back in the same order with the same times:

| Policy | Opus 5.5: in time, late, missed | cues, unexpected | Haiku 5.5: in time, late, missed | cues, unexpected |
| --- | --- | --- | --- | --- |
| Dropped, as it ran | 1, 2, 5 | 5, 2 | 4, 0, 4 | 8, 4 |
| Cue kept while its lines are in view | 3, 1, 4 | 8, 4 | 3, 1, 4 | 11, 7 |
| The same, unless an answer or topic change arrived | 3, 1, 4 | 8, 4 | 3, 0, 5 | 10, 7 |
| Everything applied | 3, 1, 4 | 8, 4 | 3, 1, 4 | 11, 7 |

Of 8 labelled moments; no cue under any policy was on screen within 5 seconds. Keeping overtaken cues brought Opus's median from 21.5 to 10.0 seconds and two more moments in time, and it also doubled the cues the labels did not expect; for Haiku it added three unexpected cues and helped nothing. The third row uses the labels to know when an answer or topic change arrived, which is the best any detector could do, and it barely differs. This replay has a hard limit: once a kept cue is on screen, the later recorded decisions were made without knowing about it (5 for Opus, 7 for Haiku), so what the evaluator would then have said is not known, they are treated as quiet, and the cue stays until it expires. So it cannot show whether a kept cue would have been withdrawn in time. On this evidence it is not a clear gain, and it is left off.

**Where the output goes.** `npm run lab:review -- --tokens <results .json>,<results .json>` works out, from a run's own counters, how much of what the model wrote was the reply the lab reads, and fits a straight line of request time against output length. For the same run:

| | Opus 5.5 | Haiku 5.5 |
| --- | --- | --- |
| Output tokens a request, median | 274 | 627 |
| In the reply the lab reads | about 75 | about 72 |
| Of that, explanation | about 60 | about 57 |
| Written but not in the reply | about 199 | about 555 |
| Request time, median | 5.4 s | 5.1 s |
| Fixed part of a request | 3.2 s | 0.9 s |
| Time per 100 output tokens | 0.8 s | 0.7 s |
| Estimate without the explanation | 5.0 s | 5.0 s |
| Estimate without the unseen working | 3.8 s | 1.4 s |
| Estimate with the three-field reply only | 3.3 s | 1.0 s |

Most of each request's output is working the reply never shows, far more for Haiku than Opus; the explanation is most of the visible reply but little of the time. The estimates say a lower effort matters much more than a shorter reply, and that Haiku has far more to gain than Opus, whose requests have about three seconds that do not depend on length. Reply sizes are estimated at four characters to a token, and the line is fitted to one run's 38 requests: it suggests what to try, and only a run measures it.

**What the budget allows.** `npm run lab:sim -- --budget` works out, offline, how many of the 30 labelled moments an evaluator that agreed with every label would cue, and how many of those cues would be on screen within 5 seconds of the line being said, for each pair of transcription delay and decision time:

| Transcription delay | Decision 0.5 s | 1 s | 2 s | 3 s | 4 s |
| --- | --- | --- | --- | --- | --- |
| 0 s | 27 of 28 | 27 of 28 | 27 of 28 | 24 of 28 | 22 of 28 |
| 1 s | 27 of 28 | 27 of 28 | 26 of 28 | 24 of 28 | 21 of 28 |
| 2 s | 27 of 28 | 26 of 28 | 24 of 28 | 24 of 28 | 0 of 28 |
| 3 s | 26 of 28 | 26 of 28 | 24 of 28 | 0 of 28 | 0 of 28 |

Each cell is cues on screen within the budget, of cues shown. Read with the two numbers measured so far, a 3.1-second median transcription delay and a 4.5-second median decision in the first model run, the table says:

- **The two must add up to 5 seconds or less, and neither can use the whole budget.** With today's 3 seconds of transcription the decision has 2 seconds; with a 4-second decision transcription would have 1.
- **Halving the decision alone is enough.** At 3 seconds of transcription, a 2-second decision puts 24 of 28 cues inside the budget; a 3-second one puts none.
- **Shortening transcription alone is not**, unless it falls to about a second: at a 4-second decision, 2 seconds of transcription still puts no cue inside the budget.
- The handful outside the budget even at the fastest settings are cues waiting for an earlier cue to leave the single slot.

This is arithmetic on invented conversations and the lane's own labels, with fixed assumed delays and nothing for drawing the card (takes so far drew a cue 0.1 to 0.5 seconds after its time). It shows what a pair of delays cannot do. It does not show what a faster model or transcriber would decide.

It does not simulate cooldown, focus, hold, dismissal, note reminders or the companion window. A model run needs the same flags as a batch (`--run`, `--included-usage-confirmed`, `--max-calls`, an output directory) and the owner's go-ahead for that stated run; it is refused if it could need more requests than the cap, and stops at the first failure. Conversations that finished are written to the results file; the one in progress when a run stops is only in the event log. Each request carries up to six recent lines, the lines the cue on screen cites, and that cue's text, so a cue the model wrote is sent back to it.

With `--set`, each case of a set is replayed as a two-second conversation from the fixture's own cue. The phrase rules can be used there (`--evaluator rules`), but only as their recorded final outcome applied at the last line. **The rules have not been replayed on the timed conversations**: they run in Rust, and that needs an engine replay that records each line.

### What each number means

| Number | Meaning |
| --- | --- |
| Evaluations: started, applied, overtaken | Requests made; decisions that took effect; decisions dropped because a newer line arrived first. Lines skipped as bare acknowledgements are counted separately |
| Labelled moments: in time, late, missed | Of the `show` labels: a cue was on screen before the moment closed; after it closed; or never. A cue belongs to the latest moment still open when its request was made |
| Line said to cue on screen | From the end of the labelled line to the cue appearing: transcription delay, any wait, and the decision. This is the number the 5-second [budget](budgets.md) is about |
| Decision time | The evaluator's own time per request |
| Unexpected cues | Cues shown that belong to no open labelled moment |
| Flips | Cues the evaluator showed and then withdrew when no line heard by then was labelled as a reason to withdraw that cue |
| Duplicates | A second cue for a moment already cued, or the same words shown again |
| Cues over a glance | Cues shown with more than ten words, and the longest cue's word count |
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
| 2 s | 28 | 0 | 2 | 5.0 s | 4 of 28 |
| 4 s | 25 | 3 | 2 | 7.0 s | 28 of 28 |
| 6 s | 19 | 6 | 5 | 9.6 s | 25 of 25 |

With no transcription delay and a 4-second decision, 28 are in time and 6 of 28 are over the budget. These figures are with the three changes below switched on; before them the same sweep gave 28, 28, 24 and 16 in time.

What this does and does not say:

- It is arithmetic on invented conversations and on the lane's own labels, with two assumed delays. It is not a measurement of any model or of the app.
- It is a ceiling, not a forecast: a real evaluator will disagree with some labels, and its decision time varies.
- The two moments missed even at 0 s open while an earlier cue still holds the single slot.
- At 4 seconds, about the middle of the [recorded request times](claude-cue-lab.md#validation-record), every cue is over the 5-second budget because the transcription delay alone uses 3 of the 5 seconds, and the moments lost first are the short ones: a question put to someone by name, which the conversation answers within seconds.
- "In time" here means before the line that ends the moment has been said, or within the 18 seconds a cue may live. It does not mean the cue would have helped.

### What an offline run shows

Run offline on 14 November 2026 with the fake evaluator and default settings, all 13 conversations: 163 evaluations, 29 of them overtaken and dropped, and the eight cues it showed appeared a median 6.7 seconds after their line was said. Those figures say nothing about cues: the fake matches keywords and its delay is made up. They show that the harness counts, drops, places and scores as described. One thing in them is real arithmetic, though: a 3-second transcription delay plus any decision slower than 2 seconds is over the 5-second budget before the companion draws anything.

## Recording a simulation

A results file from the simulation can be played back as a video, to watch how and when cue cards appear. The recorder asks no evaluator anything: every decision comes from the file, whether that was written by the fake, the labels, the rules, or an approved model run.

```sh
npm run dev -- --port <port>                       # the browser preview, in another terminal
npm run lab:record -- --results <cue-sim results .json> --url http://127.0.0.1:<port> --out <directory outside the repository>
npm run lab:record -- --results <file> --url <url> --out <directory> --conversations model-eval-review --with-notebook
```

What is on screen:

- **The real companion**, at its real size, floating near the top centre of the call, where someone would keep it by the camera. It is the app's own companion window, running in the browser preview and fed the simulated session through the same stand-in the browser tests use. The session is a scripted one, not a live one, so the app says so in its own words ("Demo running · Scripted", "Demo question") and never claims a microphone.
- **A mock video call** fills the screen behind it: invented participants in a gallery of tiles, a ring on the current speaker, and captions. It stands in for a meeting app and is labelled "Mock call. Not a real meeting or meeting app." With `--portraits-cache` the tiles show invented portraits (see below) and "Synthetic portraits" is shown; otherwise they show initials. Nothing moves a mouth.
- **A small label across the top** for the whole recording: "Simulated", "Fictional", "No model" or "Real model decisions" (with "run stopped early" when it did), "Synthetic voices" when the lines are spoken, "Synthetic portraits" when the tiles have them, the conversation, where the cue decisions came from, and what the decision times are (measured, recorded with none, or made up).
- **A small lab ticker** in a corner, marked as not part of TalkQTE, showing the latest time the evaluator was asked and what it decided, including decisions that were dropped.

The notebook is not in the main video. `--with-notebook` writes a second video of the real notebook by itself, kept scrolled to the newest transcript line, where lines arrive when the results say they reached the app under the one "Speaker" label a live transcript has today. The notebook's own wording describes the app as it is today (phrase rules, no model connected); the label says where the decisions actually came from.

**Sound.** At normal speed the fictional lines are spoken aloud behind the card, and "Synthetic voices" is shown for the whole recording. By default the speech is made on this device, offline, with macOS `say` and installed system voices, one per speaker; no speech service is used. Each line's clip is placed so that it **ends when the simulation says the line ends**, which is the moment every cue decision is timed from. Nothing in the simulation is moved to fit the speech: a clip that cannot fit after the previous speaker ends late, and the manifest lists it with by how much.

The sound is one track built offline, not captured live: every clip is resampled to 48 kHz and placed at an exact sample offset, whole, over a faint steady room tone so the space between speakers is not digital silence, with a few milliseconds of fade at each clip's edges. The track is then joined to the finished picture without re-encoding it. Because nobody listens to a take while it is made, the finished file is decoded and measured against its clips in 50 ms steps: speech missing from the file, a missing ending, clips overlapping, and sound in the gaps. The manifest holds the result, and says how it was checked. Without `say` the recorder uses plain test tones if `ffmpeg` is there (labelled "Test tones"), and without `ffmpeg`, or with `--no-sound` or another `--speed`, the video is silent.

**More natural voices, as a separate optional step.** `npm run lab:voices` makes the clips with a hosted text-to-speech service instead (OpenAI's `gpt-4o-mini-tts`, the provider's preset voices, one per speaker, with a short instruction for a conversational manner; nothing is cloned) and caches them outside the repository; `--voices-cache <directory>` then makes the recorder use them when the cache holds a clip for every line.

```sh
npm run lab:voices -- --conversations standup-flaky-test --cache <directory outside the repository>
npm run lab:voices -- --conversations standup-flaky-test --cache <directory> --run --max-chars 1000 --env-file <private dotenv file>
npm run lab:record -- --results <file> --url <url> --out <directory> --voices-cache <directory>
```

**Invented portraits, also separate and optional.** `npm run lab:portraits` makes one portrait for each speaker with a hosted image service (OpenAI image generation) and caches it outside the repository; `--portraits-cache <directory>` then makes the recorder show them when the cache holds one for every participant. Each description asks for an invented person who does not exist, with an age range, a look, clothes and a room, in the same webcam framing and light; it names no one, and no real or famous person is described. It needs `--max-images`, and otherwise follows the same rules as the voice step below. Voices and portraits are cast together, so a speaker's voice and picture agree.

The rules for both steps:

- Without `--run` nothing is sent: it lists every line or description, what is new, and a rough cost.
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

**Review after recording.** Every saved take gets a review beside it (`.review.md` and `.review.json`), and `npm run lab:review -- --take <take .json> --results <results .json>` reviews an existing one. It reads only the take's manifest and the results it was recorded from; it asks no model. It answers three things:

- **Does the take show the product as it is?** That it says what it is; which version of the app it shows and whether that checkout had uncommitted changes; that the companion's own status claims no microphone or live session; whether the whole conversation was played or the run stopped; whether cues were drawn when the results say; whether each card fitted its window; whether the cue's words stand out from the card (the contrast of the weakest word, by the WCAG formula, as the card appears and a second later, against the 4.5:1 the accessibility guideline asks for, or 3:1 for large text); and whether the sound measured intact.
- **Were the cues any good?** For each cue: its length against a ten-word glance, which labelled moment it was for and whether it came in time or late, how long after the line was said it appeared against the 5-second budget, how long it stayed and what cleared it, and whether that was long enough to read (about a second plus a quarter of a second a word, a rough allowance and not a measurement of any reader). Then the moments that got no cue.
- **What does it suggest improving?** Observations, each with the numbers behind it: where transcription delay plus decision time cannot meet the budget; a decision thrown away because a short acknowledgement arrived; a cue shown after its moment had passed; a cue too long to glance at, too faint to read as it appears, or cleared before it could be read; a cue proposed again after it was cleared; questions to the listener that could not be recognised without a name.

It also says plainly when a take is not worth drawing conclusions from: a run that stopped early, fewer than two cues, decisions that did not come from a model, or no cue that was both short enough and on screen long enough to read. The first model run's take is reviewed that way.

A review counts against the lab lane's own labels on an invented conversation. It can show that the product could not have helped at a moment; it cannot show that it did.

**Comparing runs.** `npm run lab:review -- --compare <results .json>,<results .json> [--out <directory outside the repository>]` sets two or more runs of the same conversations side by side, for example the same three conversations through two models. For each conversation and each run it gives: whether the run completed, the number of decisions and their median time, how many labelled moments got a cue (matching the label), how many in time, how many on screen within 5 seconds, how many cues were ten words or fewer and the longest, cues where the labels expected none, repeats (the same words again, a second cue for one moment, or a cue proposed again after one was cleared), cues shown and taken back, and quiet kept. A conversation that one run did not reach is left out and named. One run of each model is one sample: a difference may not repeat.

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

For the simulation they cover: a cue appearing one decision after its line and being scored against its moment; an overtaken decision being dropped with one catch-up; never two requests at once; the minimum gap and the dry-run bound; expiry after 18 seconds; the six-line window and what an app-style request contains; each count in the table above on a small scripted conversation; the labels evaluator acting only where a label says to and losing moments as its delay grows; the model a run asks for, records and accepts a reply from; the compact reply and the effort asked for, checked and recorded; an overtaken cue kept only while its lines are in view; a recorded run replayed identically and looked at under each policy without asking anything; where a run's output went; two runs set side by side; an acknowledgement neither starting an evaluation nor overtaking one, while a real new turn and an answer to a question still do; the earlier cues each request lists and their limit; the listener's name sent with one speaker label kept; the budget table's arithmetic; a stopped run resuming without repeating its decisions, with the cap counting new requests only and nothing reused under another prompt; a failed request sorted into a kind without keeping the CLI's words; the glance prompt and the count of cues over it; stopping at the cap and at the first failure with the log intact; every refusal happening before any process; repeatability; and the shape of the conversation fixture.

`scripts/cue-sim-review.test.mjs` (part of `npm run test:cue-lab`) reviews small scripted takes and checks each verdict and observation: a complete take with readable cues, a stopped run, a long cue, a cue cleared too soon, a decision thrown away by an acknowledgement, a late cue, and a status that claims a microphone.

`scripts/cue-sim-media.test.mjs` (part of `npm run test:cue-lab`) builds a sound track from generated tones and checks that the measurement passes it and fails a track with a hole in a line, a missing ending, or overlapping clips; that casting gives every invented speaker of every bundled conversation a distinct preset voice and a description naming no one; and the portrait step against a stand-in provider (nothing sent without `--run`, the cap, the cache, the key absent from output and log, and a refusal reported by short identifiers only).

`scripts/cue-sim-voices.test.mjs` (part of `npm run test:cue-lab`) checks the voice step against a stand-in provider: nothing sent without `--run`; the cap, the key and a bundled conversation required; only the lines, a voice and instructions sent; each clip cached and not bought again; the key absent from every output and log; and the first failure ending the run.

The recorder's browser test (`tests/lab-recording.spec.ts`, Chromium and WebKit) is opt-in, `npm run test:lab-record`, and is not part of `npm test` or CI because it records video; it writes only to a temporary directory outside the repository. It records a three-line fictional conversation from a results file, with test tones for speech, and checks: one video with a sound track and no raw capture left; the cue seen in the companion by its words and seen to leave; no notebook in the main view and a second video only with `--with-notebook`; the on-screen labels; a take that cannot show its cue being deleted; a folder inside the checkout being refused; and the command refusing other hosts and anything but the bundled conversations.
