# Claude cue lab

An optional development runner for one bundled fictional scenario at a time. It asks Claude Code with Opus 5.5 whether to show a cue, stay quiet, mark an existing cue resolved, or withdraw one whose context has moved on. It also distinguishes possible cue use from uncertain attribution. It does not drive the desktop app, listen to calls, import chats, save prompts into notes, or train a model.

The [intelligence plan](cue-intelligence.md) explains the hypotheses. Matching the expected labels on these small examples is a smoke check, not evidence that TalkQTE improves participation.

## Start without inference

Requires Node 22 or newer. Listing cases and running offline tests require no Claude installation, account, dependency download, or model access:

```sh
npm run lab:claude
npm run test:cue-lab
```

The eight fictional cases cover a missing owner, an already-answered issue, a visible cue being resolved, a question asked but unanswered, a topic change, uncertain speaker attribution, a context reminder, and an instruction embedded in a transcript. Expected labels are withheld from the model. Only bundled cases are accepted; there is no arbitrary transcript/file input or unattended loop.

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

On 8 November 2026, all 11 offline tests passed, repository formatting passed, and Claude Code 2.1.318 returned a subscription login through the isolated check. No live model result is recorded yet. The remaining acceptance step is one explicitly initiated fictional case after verifying included-usage billing, followed by human inspection of its evidence and decision.

Record any live trial's selected fixture, model, CLI version, outcome, and latency separately; do not describe the entire suite as evaluated after a single trial. Keep account information and raw provider/session output outside the repository.
