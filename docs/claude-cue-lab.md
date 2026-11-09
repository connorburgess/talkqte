# Claude cue lab

An optional development runner for one bundled fictional scenario at a time. It asks Claude Code with Opus 5.5 whether to show a cue, stay quiet, mark an existing cue resolved, or withdraw one whose context has moved on. It also distinguishes possible cue use from uncertain attribution. It does not drive the desktop app, listen to calls, import chats, save prompts into notes, or train a model.

The [intelligence plan](cue-intelligence.md) explains the hypotheses. Matching the expected labels on these small examples is a smoke check, not evidence that TalkQTE improves participation.

## Start without inference

Requires Node 22 or newer. Listing cases and running offline tests require no Claude installation, account, dependency download, or model access:

```sh
npm run lab:claude
npm run test:cue-lab
```

The bundled fictional cases cover a missing owner, an already-answered issue, a visible cue being resolved, a question asked but unanswered, a topic change, uncertain speaker attribution, a context reminder, an instruction embedded in a transcript, a corrected premise, a paraphrased use, and a repeated trigger. The last three were added after the validation record below and have not been run. Expected labels are withheld from the model. Only bundled cases are accepted; there is no arbitrary transcript/file input or unattended loop.

## Check the subscription, then run one case

Install the official, unmodified Claude Code CLI and use its normal subscription sign-in flow. This runner requires version 2.1.318 or newer for the isolation flags checked during development. It does not install, update, log in, or change billing for you.

```sh
npm run lab:claude -- --check
```

This verifies the CLI version and a first-party subscription login without inference or printing account identity. **The CLI authentication report does not verify whether paid extra usage is enabled.** Check that usage credits/extra usage is off in your Claude account before the model run. If you cannot establish this, stop after the login check. The acknowledgement below records that manual check; it cannot enforce the account's server-side spending setting.

```sh
npm run lab:claude -- --run --case already-answered --included-usage-confirmed
```

This sends the selected fictional context to Anthropic and consumes the subscription's shared allowance. It is hosted inference. The runner rejects API-key or unknown authentication, removes inherited credential/provider overrides from the child environment, disables Fast mode, and provides no API fallback. It never purchases credits or changes your account. See [subscription access and billing](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan).

One invocation requests one case, with a 60-second inference deadline, bounded output, and no runner retry or alternate model. Limits and failures end the evaluation. Standard CLI version/authentication checks precede the model request. No `--bare` flag is used because that mode requires API authentication rather than subscription login. [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless mode](https://code.claude.com/docs/en/headless).

## Isolation and output

The CLI runs in a fresh temporary directory with built-in tools, slash commands, customizations, and MCP connections disabled; session persistence is off. No repository files are passed to the model. The runner deletes its temporary directory and writes its report only to stdout. These controls are not a claim of zero provider retention or zero CLI diagnostic/account state. Administrative policy can still affect CLI behavior; use a separately reviewed setup before considering any real conversation data. The lab currently accepts only fictional fixtures.

The report contains the model/version, elapsed wall time, reported token counters, decision, expected labels, and whether those labels match. It excludes raw CLI output, credentials, account identity, and session IDs. CLI token-price estimates are not proof of an actual charge or remaining subscription allowance.

Validation rejects unknown source IDs, malformed decisions, invented use labels, resolution without an existing cue, and replacement of an existing cue. Source-ID validation proves only that referenced events exist. A person must still judge whether the cited text supports the decision and whether the cue is useful. A timely response in this isolated runner does not establish end-to-end live meeting latency.

CI runs only the offline tests using fake CLI responses. Live model requests are explicit local experiments, never part of CI or the progress routine. No production runtime or distribution dependency is selected by this lab.

## Validation record

On 8 November 2026, all 11 offline tests passed, repository formatting passed, and Claude Code 2.1.318 returned a subscription login through the isolated check. After confirmation that paid extra usage was disabled, one live fictional case completed:

| Case               | Model / CLI                 | Observed result                                                                        | Request wall time |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------- | ----------------- |
| `already-answered` | `claude-opus-5-5` / 2.1.318 | `quiet`, no cue, `not_observed` use; cited `e1` and `e2`, matching the expected labels | 3,615 ms          |

Inspection of the fixture supports this decision: the first line leaves the checklist owner open, and the second explicitly assigns it to Maya. The runner verified subscription authentication and the returned model ID. Reported usage was 2 input tokens, 1,205 cache-creation input tokens, 0 cache-read input tokens, and 116 output tokens; these counters do not establish the account's remaining allowance or constitute a billing receipt.

This timing includes the inference CLI's startup and response, excluding the separate version/authentication checks. Repeated latency and useful participation during a conversation remain unvalidated.

On 9 November 2026, with the owner's authorization, the other seven cases were run once each. Claude Code 2.1.318 again reported subscription authentication, no API key or provider override was set, and paid extra usage was confirmed off. Each case was one invocation with no retry.

| Case                     | Model / CLI                 | Observed result                                                               | Request wall time | Output tokens |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------- | ----------------- | ------------- |
| `missing-owner`          | `claude-opus-5-5` / 2.1.318 | `quiet`, `not_observed` use; cited `e1`, `e2`; expected `show`                | 4,096 ms          | 236           |
| `visible-cue-resolved`   | `claude-opus-5-5` / 2.1.318 | `resolved`, `not_observed` use; cited `e1`, `e2`; matches the expected labels | 4,956 ms          | 197           |
| `asked-but-unanswered`   | `claude-opus-5-5` / 2.1.318 | `quiet`, `possible` use; cited `e1`, `e2`, `e3`; matches the expected labels  | 5,298 ms          | 215           |
| `topic-moved-on`         | `claude-opus-5-5` / 2.1.318 | `withdraw`, `not_observed` use; cited `e2`; matches the expected labels       | 5,182 ms          | 91            |
| `uncertain-speaker`      | `claude-opus-5-5` / 2.1.318 | `quiet`, `unknown` use; cited `e1`, `e2`; matches the expected labels         | 5,325 ms          | 168           |
| `context-reminder`       | `claude-opus-5-5` / 2.1.318 | `show`, `not_observed` use; cited `e1`, `e2`; matches the expected labels     | 5,768 ms          | 321           |
| `transcript-instruction` | `claude-opus-5-5` / 2.1.318 | `quiet`, `not_observed` use; cited `e1`, `e2`; matches the expected labels    | 5,290 ms          | 112           |

Later on 9 November 2026, with the owner's authorization given that morning, the three cases labelled that day were run once each under the same conditions (Claude Code 2.1.318, subscription authentication, no API key or provider override, paid extra usage confirmed off by the owner).

| Case                | Model / CLI                 | Observed result                                                                 | Request wall time | Output tokens |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------- | ----------------- | ------------- |
| `context-corrected` | `claude-opus-5-5` / 2.1.318 | `withdraw`, `not_observed` use; cited `e1`, `e2`; matches the expected labels   | 3,703 ms          | 108           |
| `paraphrased-use`   | `claude-opus-5-5` / 2.1.318 | `resolved`, `possible` use; cited `e1`, `e2`, `e3`; matches the expected labels | 4,085 ms          | 104           |
| `repeated-trigger`  | `claude-opus-5-5` / 2.1.318 | `quiet`, `not_observed` use; cited `e1`, `e2`; matches the expected labels      | 4,807 ms          | 109           |

Its reasons were specific: for `context-corrected`, that the second line reverses the first so the cue "has lost its basis" without a new date being given; for `paraphrased-use`, that a speaker identifying as Priya saying "I'll send it" answers the ownership question; for `repeated-trigger`, that the second line repeats the need without naming an owner, so a new cue would duplicate the existing one.

Across all eleven cases, run once each, the evaluator matched the expected labels in 10; across the first eight, in 7.

On 10 November 2026, with the owner's authorization for a repeated batch, every case was run twice more under the same conditions (Claude Code 2.1.318, `claude-opus-5-5`, subscription authentication, no API key or provider override, paid extra usage confirmed off by the owner), one invocation each, 22 in all. The three runs of each case agreed on the action every time, including `missing-owner`, which stayed `quiet` three times for the same reason as before. So the single-run comparison holds: 10 of 11 expected actions in each of three passes, with no case flipping between runs. Request wall times over the 22 new runs were 2,969 to 5,505 ms (3,615 to 5,768 ms across all 33), including CLI start-up. The 22 runs reported 27,262 input tokens, nearly all cache creation, and 3,404 output tokens, about 155 output tokens a run; these counters are not a billing receipt and say nothing about the account's remaining allowance.

| Case                     | Expected   | Run 1      | Run 2      | Run 3      | Wall time, runs 1–3          |
| ------------------------ | ---------- | ---------- | ---------- | ---------- | ---------------------------- |
| `missing-owner`          | `show`     | `quiet`    | `quiet`    | `quiet`    | 4,096 ms, 4,971 ms, 5,164 ms |
| `already-answered`       | `quiet`    | `quiet`    | `quiet`    | `quiet`    | 3,615 ms, 3,328 ms, 4,811 ms |
| `visible-cue-resolved`   | `resolved` | `resolved` | `resolved` | `resolved` | 4,956 ms, 5,192 ms, 3,321 ms |
| `asked-but-unanswered`   | `quiet`    | `quiet`    | `quiet`    | `quiet`    | 5,298 ms, 5,505 ms, 2,969 ms |
| `topic-moved-on`         | `withdraw` | `withdraw` | `withdraw` | `withdraw` | 5,182 ms, 4,203 ms, 3,091 ms |
| `uncertain-speaker`      | `quiet`    | `quiet`    | `quiet`    | `quiet`    | 5,325 ms, 4,597 ms, 5,209 ms |
| `context-reminder`       | `show`     | `show`     | `show`     | `show`     | 5,768 ms, 4,788 ms, 5,207 ms |
| `transcript-instruction` | `quiet`    | `quiet`    | `quiet`    | `quiet`    | 5,290 ms, 3,632 ms, 3,417 ms |
| `context-corrected`      | `withdraw` | `withdraw` | `withdraw` | `withdraw` | 3,703 ms, 4,792 ms, 3,465 ms |
| `paraphrased-use`        | `resolved` | `resolved` | `resolved` | `resolved` | 4,085 ms, 5,363 ms, 3,061 ms |
| `repeated-trigger`       | `quiet`    | `quiet`    | `quiet`    | `quiet`    | 4,807 ms, 5,323 ms, 4,173 ms |

What this does and does not show: the evaluator is consistent on these eleven fictional cases, and its one disagreement with the labels is stable rather than noise. It still says nothing about usefulness in a meeting, about speech-to-text errors, or about latency with the app's own context, and eleven cases are too few to estimate a false-suppression rate; that needs a larger suite and real conversations. In `missing-owner` it stayed quiet. Its reason was that the second line already raises settling the handoff, so a cue would duplicate it. That judgment is defensible, so the case's label should be reviewed rather than counted as a clear failure. Request times were 3.6–5.8 seconds, including CLI startup, which is above the proposed 5-second budget for a visible cue in some cases. Each case ran once, so these results say nothing about consistency across runs, real meetings, or usefulness to a participant. The phrase rules scored 2 of 8 on the same cases ([comparison](cue-intelligence.md#rules-baseline-on-the-shared-suite)).

Record any live trial's selected fixture, model, CLI version, outcome, and latency separately; do not describe the entire suite as evaluated after a single trial. Keep account information and raw provider/session output outside the repository.
