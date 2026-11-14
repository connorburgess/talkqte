# Dialogue lab: generated conversations that cues can change

Status: development tooling, 14 November 2026. The engine, the agent interfaces, deterministic fakes for every agent, the dry run and offline runs exist. **No model call has been made.** The model-backed generator, participants and judge are not built yet, and a first pilot needs the owner's approval ([before a pilot](#before-a-pilot)).

**A simulated listener changing course is not a user outcome.** This lab can suggest which cue types and moments are worth testing with people in the [comparison study](comparison-study.md) (V5–V7). It cannot show that a cue helps anyone.

## Why

The [timing simulation](cue-simulation.md) scores cues against a fixed script, so it cannot show whether a cue changes what someone says. Here the conversation is generated turn by turn. The person TalkQTE helps (the listener) is simulated too, and responds to the cards it actually saw in time. Each scenario is played in paired branches from one shared start:

| Branch       | The listener gets                                                  |
| ------------ | ------------------------------------------------------------------ |
| A            | the cue evaluator's cards, under cue-sim's timing model            |
| B            | nothing                                                            |
| C (optional) | one irrelevant placebo card, at the moment A's first card appeared |

Comparing branches shows where a card changed the outcome, where it did nothing, and where it got in the way. All of this happens in simulation.

## How a run goes

1. **Briefs are generated and frozen.** A generator agent writes one brief per scenario from a generation plan (domain, and how many open, settled and decoy moments to include). Each brief is checked ([the brief](#the-brief)). A rejected brief is logged with its reasons and left out, never repaired. The run then writes the accepted briefs to a file before any conversation starts.
2. **The shared prefix.** The cast (everyone but the listener) and the listener speak turn by turn. The lab's own cue evaluator watches the transcript under the [timing model](#timing).
3. **The fork.** The prefix ends at the first listener turn where branch A would hand the listener a card. Until then every branch would be given exactly the same thing, so the prefix is generated once and shared.
4. **The branches.** Each branch continues on its own from the fork.
5. **The judge.** Each distinct transcript goes to a judge with the brief's pre-registered criteria. The judge reads the transcripts in a shuffled order, each under a random name. It is never told the branch, and never sees a card, the cue timeline or the moments.
6. **The review.** The results file compares the verdicts across branches. A review for each scenario says what can and cannot be concluded.

A scenario that never forks (no card reached the listener before one of their turns) is one conversation, judged once, and its review says that nothing about cue influence can be concluded from it.

## The brief

A brief describes a meeting, not a script. It has exactly these fields:

| Field                                                | Holds                                                                                                                                                                         | Seen by                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `id`, `domain`, `title`, `setting`                   | kebab-case id; one of software, ai, hiring, customer, planning; a short title; one or two sentences                                                                           | `title` and `setting`: cast, listener, judge                                                  |
| `focus`                                              | the listener: first name, role, goal, up to five facts it knows, up to three `distracted` windows (`fromMs`, `toMs`, what it was doing)                                       | listener only (the cast and the judge get its name and role)                                  |
| `people`                                             | two to four others: first name, role, goal, up to five private facts, and `casting`                                                                                           | cast only (the listener and the judge get names and roles)                                    |
| `casting`, on the focus person and each other person | `voice` (feminine, masculine or neutral), an `age` range of at most fifteen years such as `30-39`, and a `portrait` of at most 200 characters (hair, clothing, room, framing) | nobody: it goes to the results for voices and portraits, so casting never guesses from a name |
| `moments`                                            | what the brief planted: `unowned-task`, `question-to-focus`, `wrong-figure`, `date-slip` (open), or `settled`, `decoy` (help would be redundant), with who carries it         | nobody: the results and reviews only                                                          |
| `criteria`                                           | statements a reader of the transcript can check, each tied to a moment, phrased so that true is the better outcome                                                            | judge only                                                                                    |

The checks every brief must pass, as written:

- **Schema.** Exactly these fields, with the counts and lengths above. When a plan was given, the brief must match its domain and its moment counts.
- **Invented names and looks.** People have single first names, all different. A portrait may not compare anyone to a real or famous person. A whole-word, case-sensitive deny-list of common real companies and products, in `scripts/cue-dialogue-briefs.mjs`, rejects any brief that names one, as does any web address, email, handle or phone number. The list cannot catch everything; the generator is also told to invent every name.
- **Judgeable criteria.** Each criterion names someone in the meeting, or refers to the group ("someone", "nobody"). None may turn on thoughts, feelings, knowledge or intent, or on the card. Every moment has at least one criterion.

The three hand-written briefs in `scripts/fixtures/cue-dialogue-briefs.json` (a release check, a customer renewal call, an interview debrief) only feed the deterministic fakes in offline tests and CI. Their `offline` blocks hold the fake cast's lines, the fake listener's lines and the fake judge's patterns, and no request ever carries them. A brief from a model may not have an `offline` block. Real runs use generated briefs only.

## Agents

| Role          | Sees                                                                                                                                                                                          | Planned model |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Generator     | the generation plan only; it is asked for realistic meetings with naturally occurring moments, including some that settle themselves and decoys, and is never told that cues are being tested | Sonnet 5.5    |
| Cast          | the meeting, everyone else's goals and private facts, the listener's name and role, and the transcript                                                                                        | Haiku 5.5     |
| Listener      | the meeting, its own goal and facts, the others' names and roles, the transcript as it heard it (lines said while it was distracted arrive only as missed), and the card if one is offered    | Haiku 5.5     |
| Cue evaluator | the lab's own adapter from `scripts/cue-evaluators.mjs`, unchanged: recent lines under one speaker label, the listener's name, the cue on screen and earlier cues                             | Opus 5.5      |
| Judge         | the meeting, names and roles, the criteria's ids and words, and one transcript                                                                                                                | Sonnet 5.5    |

The participants, the cue evaluator and the judge must each use a different model; a run that names the same model for two of them is refused. Each agent's prompt is in `scripts/cue-dialogue-agents.mjs`, and the dry run prints them. The listener's prompt says only that a small card may show a line of context that may or may not be relevant, and that it may use or ignore it. It must never mention the card. The system prompt is the same in every branch; only the card differs.

What the listener is given at each of its decisions:

- **When.** It decides when the cast hands it the floor, and also, after every `--interject-every` turns by others (three by default), when it may speak up or keep listening. Up to the fork these chances are shared. After it they can drift apart, because a listener who speaks up in one branch and not in another shifts everything that follows.
- **Which card.** A card is offered only if it is on screen at the moment the listener's turn would start, and only while the listener has glances left (`--glances`, three by default).
- **What happened to each card**, recorded as one of:

| State           | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `read-used`     | the listener read the card and says it affected what it did                       |
| `read-ignored`  | the listener read the card and did not act on it                                  |
| `glances-spent` | the card was on screen, but the listener had no glances left                      |
| `never-offered` | the card appeared after the listener's last turn, or was gone before its next one |

`read-used` is the simulated listener's own account. The judge's verdicts, not that account, are the outcome.

The judge may still be able to tell a branch apart if the listener quotes a card. A listener line that mentions a card or a screen is flagged in the results and in the review.

## Timing

- **Turn length.** Each turn's spoken duration is estimated at 160 words a minute (at least 0.7 s) until it is voiced, with a 0.5 s gap between turns.
- **When a line reaches the evaluator.** A line reaches the evaluator when the speaker finishes, plus cue-sim's transcription delay (3 s). Evaluations follow [cue-sim's lifecycle](cue-simulation.md) exactly, through its own `simulate` function: the minimum gap between evaluations, dropping a decision overtaken by newer speech, skipping backchannels, the 18-second cue life, earlier cues and the listener's name.
- **When a decision lands.** A decision lands after the evaluator's measured request time. The fake evaluator's time is made up.
- **Rerunning the simulation.** At each listener decision the simulation is rerun over the lines so far. Events up to that moment depend only on lines already said, so the rerun is exact. Every evaluator answer is remembered by its exact request and never asked twice. One field differs: cue-sim marks the last line of a shortened rerun as its final line. No adapter the lab uses reads that field; one that did would need its own check.
- **No guessing ahead.** Each rerun stops before any evaluation that would start after the listener's decision, because such a request would depend on speech not yet said. When a branch ends, it is simulated once more as a whole. Every evaluation asked earlier is one of that final simulation's, so the evaluator is asked at most once per line of branch A, and the recorded timeline covers the whole conversation.

Rendering comes afterwards. Today's recorder, voices and portraits play only the bundled cue-sim conversations. The lab lane is extending them to read these results, checking each against its briefs file, and to cast from each person's `casting`. When a branch is voiced, the clip durations replace the estimates, and every card the listener used must be re-checked against them. That re-check (`retime`) is planned, not built: until it exists, a voiced branch can show a card that would have been too late at the voiced timing.

## Calls, cap and failures

- **Manual, with a cap.** Every run is started by hand with `--max-calls` (1 to 300). The cap covers generator, participant, evaluator and judge calls together.
- **Refused before it starts** if its worst case exceeds the cap. Per scenario the worst case is one generator call, plus `branches × (maxTurns + ⌊maxTurns ÷ interjectEvery⌋)` participant calls, plus `maxTurns` evaluator calls, plus one judge call per branch. With the defaults (14 turns, a chance to speak up every 3, branches A and B) that is 53 per scenario. The shared prefix and early endings make the real number smaller, and the loop still stops at the cap regardless.
- **Stop at the first failure.** A failed call, an unusable reply (a cast reply that speaks as the listener, a judge reply that skips a criterion), or the cap ends the run. The results keep everything completed, with the reason, the CLI's exit code where there is one, and the kind of failure, using cue-lab's kinds plus `invalid-reply` and `call-cap`. Nothing is retried, and no other model is asked.
- **Nothing recurring.** There is no schedule, no loop that starts by itself, and CI never makes a model call.

## Run it

```sh
npm run lab:dialogue                     # dry run: nothing started, sent or written
npm run lab:dialogue -- --branches ABC --scenarios 3
npm run lab:dialogue -- --run --agents fake --max-calls 200 --out <directory outside the repository>
npm run test:cue-lab                     # includes scripts/cue-dialogue.test.mjs
```

The dry run prints the plan, the planned models and where a model run would send its requests, the worst-case call count, and every system prompt. It then rehearses the whole run with the offline fakes and prints the exact input of every request each role makes. With models the replies differ, and so do the requests that follow; what each role is given stays the same.

Plan options: `--domains software,hiring`, `--scenarios`, `--open`, `--settled`, `--decoys`, `--seed`, `--branches AB|ABC`, `--max-turns`, `--interject-every`, `--glances`, and `--participant-model`, `--evaluator-model`, `--judge-model`, `--generator-model`. `--latency-ms` fixes the fake evaluator's delay. `--agents claude` is refused until the model-backed agents exist.

## What a run writes

Everything goes to the `--out` directory (or `TALKQTE_LAB_OUTPUT`), which must be outside the checkout, as for the other lab runs:

- `cue-dialogue-<time>.briefs.json`: the frozen briefs, written before any conversation starts.
- `cue-dialogue-<time>.json`: the results. Schema `talkqte-cue-dialogue/1`, with:
  - the seed, plan, settings, agents and call counts by role;
  - `brief: { file, sha256 }`, naming the briefs file beside it;
  - the rejected briefs, as written, with their reasons;
  - per scenario, the fork and the shared prefix's steps;
  - the criteria verdicts by branch, and which criteria differ between A and B;
  - a real-time summary;
  - `branches[]`.
- `cue-dialogue-<time>.log.jsonl`: an append-only log of every system prompt, the exact input of every request, every reply with its time, the fork, each branch's card states, and the judge's verdicts with the branch each transcript was. CLI output, session IDs, account identity and credentials are never logged.
- `cue-dialogue-<time>-<scenario>.review.md`: what this scenario can and cannot show.

Each entry of `branches[]` has the shape of a cue-sim replay, agreed with the lab lane so its recorder and meeting emulator can be extended to play it:

- `id`, `context`, `title`, `setting`, `listener`, and `participants` with each person's `casting`.
- `lines`, each with `id`, `speaker`, `text`, `startMs`, `durationMs`, `atMs` (when the speaker finishes) and `arrivesAtMs`.
- `timeline`: cue-sim's events. Placebo and recorded cards carry `sourceIds` (empty for the placebo) and `expiresAtMs` like the evaluator's.
- `listenerReads` and the judge's verdicts.

Every speaker is a participant and every name is in the briefs file.

## Saved runs are the controls

Every run saves its briefs and each scenario's shared prefix. `--replay <results.json>` replays a saved run with another cue model, effort or policy, for a like-for-like comparison:

- **What it checks first.** The briefs file must match the hash in the results, and the settings that shape turns must match the saved run.
- **What is not asked again.** The generator is not called, and the saved prefix is used turn by turn without asking the cast or the listener again.
- **An earlier fork.** If the new evaluator would have handed the listener a card earlier than the saved fork, the replay forks there and drops the rest of the saved prefix. The results record how many saved steps were used and dropped.

Replaying the same run more than once also gives repeat samples of the branches from one shared start.

## With the real app

The same generated conversation is meant to be played to the real desktop app by the lab lane's meeting emulator, with its voices, on the macOS host. The real app then captures, transcribes and cues it. Two pieces of this lab are ready for that:

- **A cue-source interface.** The listener takes its cards from a source. Today's source is the timing model; `recordedSource` takes cue-shown and cue-cleared events with times on the conversation's clock instead. Once the native development timing log exists, a small adapter can turn it into those events, and the listener reacts to what the app actually showed. Offline tests cover a recorded source.
- **A real-time plan.** The shared prefix can be generated ahead of time. After it, each turn by others can be generated while the line before it plays. A listener decision needs the card state at its own moment, so its generation time is a pause unless it is generated ahead and discarded when the card state changes. The results' `realtime` summary compares measured call times with line durations. Fakes measure nothing, so it is empty until a model run. The lab's isolated evaluator requests took 3.0–5.8 s including CLI start-up, about the length of one spoken line ([validation record](claude-cue-lab.md#validation-record)). Real-time play will probably need pauses at listener turns; a pilot's measurements will settle it.

## Before a pilot

The model-backed generator, cast, listener and judge still have to be built. They must reuse cue-lab's isolation: subscription sign-in only, refusing inherited API, provider or proxy settings, an allowlisted environment, and no tools, MCP, hooks or session persistence. Each call must name its model and effort, and a reply from any other model must be refused. The isolated call in `scripts/cue-lab.mjs` is tied to the evaluator's decision format and a fixed effort. Reusing it means a small separate change to that file, coordinated with the lab lane, rather than a copy.

A first pilot of 2 generated scenarios with branches A and B and the default settings could make at most 106 calls: 2 generator, up to 72 participant, up to 28 evaluator and up to 4 judge calls. Offline fake runs of two scenarios made 34–44 calls. Generated conversations will probably run longer, so expect 60–100. A pilot is an engine shake-down: one run per branch cannot separate a card's effect from sampling variation.

## What this cannot show

- These are simulated people, not users. A model's listener reading and using a card says nothing about whether a person would notice it, read it in time, or be helped by it.
- One run per branch: a difference can be sampling variation. Use replays for repeats before reading anything into a difference, and even then it is about a simulated listener.
- The briefs, moments and criteria are written by a model and have not been reviewed by people. The checks catch malformed or unjudgeable briefs, not unrealistic ones.
- The clock is simulated, and turn durations are estimates until voiced.
- The judge is a model. It is blind to the branch, but its verdicts are not ground truth.
