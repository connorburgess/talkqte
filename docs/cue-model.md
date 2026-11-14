# Model-decided cues: design

Status: design note, 14 November 2026. Updated the same day: the development backend is implemented behind the `claude-cli` Cargo feature and tested against a fake `claude` executable. No model has been called from the app. The first real call needs the owner's go-ahead. The owner has decided that the real app's cues come from a model, and that the phrase rules in `src-tauri/src/engine.rs` will be removed, because they do not decide what a conversation needs.

A build without a model connection shows no cues and says so. This note says how the model is reached from the app, what leaves the device, and what happens when it fails.

It builds on parts that already exist and are tested only with fictional adapters:

- the provider-independent [evaluator worker and session permission](cue-evaluator.md);
- the [processing proposal](processing-plan.md), whose failure table this note keeps;
- the [lab](claude-cue-lab.md) and [simulation](cue-simulation.md), whose request, prompt and CLI isolation it reuses rather than forks.

## The order of work

1. This note.
2. A development backend that calls the Claude Code CLI with the owner's own subscription, behind an explicit connection, with a visible sending indicator, a development decision log, and disclosure in the app, [PRIVACY.md](../PRIVACY.md) and the README.
3. Removing the phrase rules, their cues and their tests, and rewriting the documents that describe on-device cue decisions.

The development backend is for the owner's own use and the lab only. A shipped product cannot share one person's subscription among its users, and no production provider is chosen. That release blocker is recorded in the [product readiness plan](product-readiness.md#model-provider-for-a-shipped-product).

## Where it runs

All of it runs in the Rust engine; React stays a renderer.

The engine already owns these, and keeps them:

- when to ask;
- what goes in a request;
- checking the reply;
- applying it under the lifecycle rules: one cue at a time, the 18-second unread lifetime from the newest cited line, cooldown, hold, dismissal, pause and Stop;
- the permission that allows sending at all.

The evaluator worker in `src-tauri/src/cue_evaluator.rs` runs the backend on its own thread, never in an audio callback or a UI command.

React sends only controls, through narrow commands: connect, disconnect, approve, pause, dismiss and hold. It receives the existing cue snapshot plus a content-free status. It never sees a prompt, a raw reply, a command line or a credential.

The backend is replaceable behind the existing `Evaluator` trait. The engine does not know which backend answers, only that a validated decision came back in time. The browser preview keeps its fictional simulation and never calls a backend.

## The request

It has the same shape as the lab's app-style request (`buildPrompt` in `scripts/cue-lab.mjs`, with the simulation's cue history and listener name), so a decision measured in the lab is a decision the app would get.

```json
{
  "events": [{ "id": "transcript:…", "speaker": "Speaker", "text": "…" }],
  "existingCue": { "text": "…", "sourceIds": ["transcript:…"] },
  "userName": "…",
  "earlierCues": [{ "text": "…", "state": "resolved" }]
}
```

- **`events`:** the newest six fresh transcript lines, plus any older lines the cue on screen cites. Every line carries the one label "Speaker", as live transcripts do today.
- **`existingCue`:** the cue on screen, or `null`.
- **`userName`:** the listener's session name, only when Settings has one.
- **`earlierCues`:** up to four cues this session has shown, oldest first, each with how it ended (`resolved`, `withdrawn` or `expired`). A cue the person dismissed is listed as `expired`. The field is present only when there is something to list. A cue decided but never shown is not listed.

The system prompt is the lab's compact prompt, with its glance rule, the sentence that says whose name `userName` is, and the sentence about earlier cues. The prompt text, the CLI arguments and the inherited-credential list will move into one shared file, read both by the lab scripts and by the Rust build (`include_str!`). The lab and the app then cannot drift apart, and a test on each side checks that the copy it uses is that file. Its location is chosen when the lab scripts are changed to read it.

The existing request bounds stay:

- at most 32 sources;
- at most 4,096 bytes of text per line;
- at most 32 KiB in all;
- an oversized request fails before anything is sent, with no truncation and no partial batch.

Prior notes are not sent in the first version. The approved-note path in the evaluator stays, but the connection does not offer it until a separate review.

**When a request is made.** A request is made on a new transcript line, at least two seconds after the previous request, as in the simulation. Only one request is ever in flight. A line that arrives while one is in flight cancels it, and one catch-up request follows with the latest lines, using the existing coalesced scheduling. No backlog is kept and nothing is replayed.

The simulation's rule that sets aside "Mm" and "Yeah" is a phrase list that decides when to ask. It is not adopted in the first version, which keeps the app free of phrase rules. It can be revisited with the lab's evidence on overtaken decisions.

## The reply and its validation

The reply is the lab's compact reply, exactly three fields:

```json
{
  "action": "show|quiet|resolved|withdraw",
  "cue": null,
  "sourceIds": ["transcript:…"]
}
```

Anything else fails validation and shows nothing. Each rule below is checked:

- the reply is a single JSON object of at most 4,096 bytes;
- no field is unknown, missing or repeated;
- `action` is one of the four values;
- `show` comes only when no cue is on screen, with a non-empty cue of at most 240 characters;
- `quiet`, `resolved` and `withdraw` carry `"cue": null`;
- `resolved` and `withdraw` come only when a cue is on screen;
- `sourceIds` holds one to four distinct IDs, each from the request's `events`.

The glance rule asks for at most ten words; a longer cue is still shown, and its length is recorded in the decision log.

The current evaluator expects five fields, including `reason` and `observedUse`. It will accept the three-field reply instead, and those two fields are dropped. Nothing from a reply is kept beyond the cue it shows.

The CLI's own JSON wrapper is checked before the decision inside it:

- the result reports success;
- its model usage names only the requested model, or the reply is refused.

A valid decision is applied only if the request it answers still matches the current session, sources, cue on screen and permission. A reply that has gone stale is dropped and recorded as stale.

## Timeouts and failure

Each request has a deadline of eight seconds by default. The development setting can change it within the worker's existing ten-second ceiling. A cue that would arrive more than 18 seconds after its newest cited line is refused, as it is now.

There is no retry, no fallback to another model, no fallback to phrase rules and no queue. Capture and the transcript carry on whatever happens.

**Slow replies (the owner's rule, 14 November 2026).**

- **One reply over the deadline is skipped.** No cue is shown that time, the late result is dropped when it arrives, and the next new line is sent as usual.
- **Two timeouts in a row stop cues for the session**, with the plain reason.
- **A reply in time resets the count.**

The count is `TIMEOUTS_TO_STOP` in `src-tauri/src/engine/evaluation.rs`, so changing it is a one-line edit.

**Every other failure stops sending at once** for the rest of the session: usage limit, sign-in, inherited credentials, an unusable reply, and a CLI error. The reason is shown in plain words in the notebook. Sending starts again only when the person reviews and turns the connection back on.

| What happened                                                                   | What the person sees                                                                                               | Sent?                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| The connection is off, or this build has no backend                             | "No cues: the model connection is off." or "No cues: this build has no model connection."                          | Nothing                  |
| The Claude Code CLI is missing, too old, or not signed in to a subscription     | "Cues are off: Claude Code is not installed / needs updating / is not signed in."                                  | Nothing                  |
| An API key, provider switch, gateway or proxy setting is inherited              | "Cues are off: an API key or provider setting is present, and this connection uses only your Claude subscription." | Nothing                  |
| A usage or rate limit was reached                                               | "Cues stopped: your Claude usage limit was reached."                                                               | No more                  |
| No connection, or the CLI reported an error                                     | "Cues stopped: the model could not be reached."                                                                    | No more                  |
| The deadline passed once                                                        | Nothing; that request is skipped                                                                                   | The next line, as usual  |
| The deadline passed twice in a row                                              | "Cues stopped: the model took too long to reply twice in a row."                                                   | No more                  |
| The reply was unreadable, malformed, from another model, or cited unknown lines | "Cues stopped: the model's reply could not be used."                                                               | No more                  |
| The request would be too large                                                  | "Cues stopped: the conversation lines were too long to send."                                                      | Nothing for that request |

The wording above is what the notebook shows; the companion shows that cues are off. A usage limit and a rate limit share one message, because the CLI's wording does not reliably tell them apart.

## What leaves the device, and when

**Nothing is sent until the person turns the connection on.** It is off at every start and lasts only for the session. Turning it on shows a review screen stating where lines go, what is sent and when:

- **Where:** to Anthropic, through the Claude Code CLI on this Mac, using the person's own signed-in Claude subscription and its usage allowance.
- **What:** the request above. That is up to six recent transcript lines and the lines the cue on screen cites, the cue on screen, up to four earlier cue texts with how each ended, and the session name if one is set.
- **When:** after a new transcript line, at most once every two seconds, one request at a time, until the session stops, the person turns the connection off, or a failure stops it.

**Never sent:**

- audio, or the full transcript;
- notes typed in the notebook, or imported notes;
- focus lines;
- file paths, account details, or device or input names.

**Visible while it is on.** The notebook and the companion both show that the connection is on, and show when a request is being sent. The indicator stays visible as long as the connection is on. Stop, ending the session and quitting the app turn the connection off. Pause cues cancels any request in flight and sends nothing until speech resumes.

**What Anthropic does with what is sent** follows the person's own Claude account terms and settings. The CLI runs with session persistence off. That does not remove the provider's own retention, or any local state the CLI keeps, and the app does not claim either is removed. Lines already sent cannot be recalled.

## The development backend

- **Build.** A Cargo feature, `claude-cli`, used in development builds only.
- **Arguments.** It starts `claude` with the lab's isolated arguments: print mode, no tools, no MCP, no slash commands, no session persistence, hooks off, `switchModelsOnFlag: false`, only the requested model available, and JSON output.
- **Environment.** It passes an allowlisted environment, and refuses to start if any inherited credential name from the lab's list is present.
- **Model and effort.** Chosen from the lab's options with the development settings `TALKQTE_CUE_MODEL` (`opus-5.5` or `haiku-5.5`) and `TALKQTE_CUE_EFFORT` (`low` or `medium`), read when a live session starts. The default is the lab's, Opus 5.5 at medium. An unknown name leaves the session with no model connection rather than reaching another model.
- **Checks.** Version and subscription sign-in are checked once per session, on the first request, before that request is sent. Inherited credentials are checked before every request.
- **Limits.** Standard output is capped at 128 KiB. The child process is ended on cancellation or deadline, so a slow call cannot hold the worker.
- **No retries.** There is no `--fallback-model` and no API path.

**The decision log** is development-only and shares one file and one format with the real-app timing log (`src-tauri/src/timing_log.rs`). It is behind the `timing-log` feature and an explicit file path, and nothing is sent anywhere. The backend records four events beside the timing log's own:

- `evaluator`: the connection turned on or off, with model, effort and backend;
- `evaluation_requested`: session, request number, the last line covered, the number of lines sent, and whether a cue was on screen;
- `evaluation_result`: one of `show`, `quiet`, `resolved`, `withdraw`, `failed`, `stale` or `cancelled`, with latency and a fixed failure code;
- `cue_decision` with `decider: "model"`, the request number and the cue's words, recorded where the engine accepts the cue. Phrase-rule cues carry `decider: "phrase_rule"`.

`evaluation_result` failure codes are `timeout`, `invalid_reply`, `rate_limited`, `input_limit`, `sign_in`, `credentials` and `unavailable`. These events carry ids, counts and fixed codes, never the prompt or the raw reply. A reviewer joins them to the timing log's lines and cue text. Tools such as the dialogue simulation's listener can read the real app's cues from those same events, or from the existing cue snapshot, with no new interface.

## Acceptance for the later changes

**Development backend**, with a fake `claude` executable, no model call:

- nothing is sent before the connection is on, after it is off, or after Stop;
- the review screen's content matches the request;
- inherited credentials, an old version and a missing sign-in are refused before any request;
- the arguments and environment match the lab's;
- a slow child is ended at the deadline;
- each failure row above produces its plain reason and stops sending;
- a reply from another model is refused;
- the indicator is visible while sending;
- the decision log carries no text.

The first real call needs the owner's go-ahead, on fictional speech.

**Removing the phrase rules:**

- a build without the backend raises no cue from any line and says why;
- the lifecycle rules stay covered by tests that use fictional evaluators;
- no document claims on-device cue decisions.

**Still open whatever these changes pass:**

- latency against the [budgets](budgets.md) in a live session;
- cue quality and usefulness, which the [comparison study](comparison-study.md) is for;
- a production provider.
