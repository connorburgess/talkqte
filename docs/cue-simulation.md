# Cue lab batches and simulations

Status: development tooling, 14 November 2026. It extends the [Claude cue lab](claude-cue-lab.md) from one case per invocation to a bounded batch over a bundled fictional set. No model run was made for this change; everything recorded here was run offline with a fake evaluator or with the phrase rules' recorded outcomes. Nothing here connects a model to the app.

The tooling exists to learn when a cue should appear, stay away, or leave. It cannot show that a cue helps anyone. Read [what the numbers do not show](#what-the-numbers-do-not-show) before quoting any of them.

## Evaluators

Everything that decides about a cue sits behind one adapter in `scripts/cue-evaluators.mjs`, so another provider (a different CLI, a local model) is one more function there and nothing else changes.

| Evaluator | What it is | Leaves the device |
| --- | --- | --- |
| `claude` | Claude Code with Opus 5.5 through the subscription sign-in, with the isolation described in the [lab page](claude-cue-lab.md#isolation-and-output) | Yes: the fictional case text goes to Anthropic. Hosted inference |
| `fake` | A deterministic keyword stand-in with a made-up delay. It proves the harness. It is not the app's rules and not a model | No |
| `rules` | The phrase rules' recorded final outcome for each case, read from `scripts/fixtures/cue-rules-recorded.json` | No |

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

`--out` (or the `TALKQTE_LAB_OUTPUT` environment variable) must be an absolute path outside the checkout. The runner refuses a path inside the repository, including through a link, so results, logs and recordings cannot be committed by accident.

## A bounded model run

A model run is an explicit, one-off local experiment. It needs the owner's go-ahead for that stated run (which set, how many requests), and the same manual check as before that paid extra usage is off in the Claude account:

```sh
npm run lab:claude -- --check
npm run lab:batch -- --set held-out --run --out <directory outside the repository> --max-calls 23 --included-usage-confirmed
```

What the runner enforces:

- **A call cap.** `--max-calls` is required, from 1 to 100. A run that would need more requests than the cap is refused before anything starts, and the loop stops at the cap regardless.
- **No API key, ever.** If the shell carries an API key, auth token, base-URL override or provider switch (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_…` and similar), the run is refused before any process starts and the message names the variables, never their values. The existing checks still apply after that: the child process gets an allowlisted environment, and an API-key, routed or unknown sign-in is rejected before any model request.
- **One sign-in check, then one request per case, one at a time.** No retry, no alternate model, no fallback.
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

## What the numbers do not show

- **The cases are fictional.** Sixty-eight short conversations give no rate for real meetings.
- **Label agreement is not usefulness.** A match means the evaluator chose what the author of the case expected. The labels were written by the lanes, not observed in meetings, and await the owner's review. One label in the first set is already disputed.
- **Nothing here is evidence of participation or comprehension.** Whether a cue helps someone stay grounded and respond is the question for the [comparison study](comparison-study.md), with people.
- **Agreement with the rules is not correctness.** Both can be wrong together, and the rules were tuned on two of the three sets.
- **Batch latency is not cue latency.** It is one isolated request including CLI start-up, with no transcription delay, no other speech arriving, and no window to draw.
- **The fake evaluator's scores mean nothing.** They exist so that the harness, the files and the summary can be checked before any model is involved.

## Checks

`npm run test:cue-lab` runs the offline tests for the single-case lab and the batch runner. They cover: the dry run starting nothing; every refusal above happening before any process; one sign-in check and one request per case; stopping at the first limit, error, wrong model or malformed reply without retry; the call cap; labels never reaching the evaluator; the first set's prompt being unchanged; the rules record matching the engine's tests; results being refused inside the checkout; and the fake evaluator being repeatable. CI runs them with no model, credentials or network.
