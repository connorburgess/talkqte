# Cue processing and permission proposal

Reviewed 10 November 2026. This is a proposed activation contract, not an enabled setting or permission to run inference. The app still uses phrase rules. The [development evaluator](cue-evaluator.md) has bounded requests, source disclosure, cancellation and catch-up scheduling, but no app command constructs it and no provider is connected.

The purpose is timely, relevant context while someone keeps listening. Processing permission, source membership and a successful model response do not establish relevance or useful participation. The [no-assistance comparison](research.md#the-next-experiment) remains separate.

## Recommended next step

The session-scoped permission boundary is now [implemented and tested with fictional adapters](cue-evaluator.md#session-processing-permission), without starting a model process. The proposed controls now have [fictional IPC and headless UI acceptance](processing-controls.md). The development engine now distinguishes [quiet decisions from unavailable processing](cue-evaluator.md#evaluation-availability-before-native-controls) and requires fresh approval after a concrete failure. Next, implement and test the native command/event contract before mounting the controls in the app. Retain the existing Claude Code lab as the first candidate for a later, separately authorized fictional replay. Keep local reasoning as the intended distribution option to evaluate, rather than requiring a coding subscription for ordinary use. No production provider is selected by this recommendation.

The [recorded lab](claude-cue-lab.md#validation-record) contains 33 authorized fictional calls: 10 of 11 expected actions in each of three passes, with one disputed expected label. Request wall time was 2,969–5,768 ms including CLI startup. Some requests already exceeded the five-second visible-cue target before transcription and app delivery. The [scheduling checks](cue-evaluator.md#coalesced-speech-scheduling) show that newer speech can invalidate every slow reply. More model calls are not the next prerequisite; an explicit boundary and a realistic end-to-end acceptance plan are.

## Processing choices

| Choice | What exists | Decision and remaining evidence |
| --- | --- | --- |
| Current local phrase cues | Implemented; no reasoning provider. The optional developer build transcribes the user's microphone locally. | Remains the default. Phrase matching is not semantic meeting understanding. |
| Personal subscription CLI experiment | An isolated, manually invoked Claude Code lab accepts fictional fixtures only. | First comparison candidate, not a live or production service. A later replay needs an exact fixture/call cap and explicit authorization; account/model access, extra-usage setting, cancellation, retention and latency must be checked again. |
| On-device reasoning | No model or adapter selected. Whisper performs transcription, not reasoning. | Evaluate model quality, licence, delivery size, memory/CPU/energy and latency on the supported Mac alongside transcription. Do not promise that an arbitrary local model fits. |
| Cursor CLI comparison | No TalkQTE adapter or validation record. | Alternative only if a specific comparison is warranted; account allowance, model access, isolation, retention and distribution remain unverified. No automatic fallback. |

Separately billed APIs, project-funded inference, shared subscriptions, recurring lab runs and live hosted processing are outside the current implementation scope.

## Current provider evidence and limits

These links were checked on 10 November 2026; account state was not inspected and no CLI or model was run.

- Claude Code documents subscription login and a shared usage allowance. An inherited `ANTHROPIC_API_KEY` takes precedence and can cause API charges. The existing lab removes provider overrides and requires subscription authentication; its manual extra-usage acknowledgement cannot enforce server-side billing settings. Stop at limits, without switching accounts, buying credits or retrying through another billing route. [Subscription access and billing](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan).
- CLI print mode is supported, but `--bare` bypasses subscription credentials. Normal print mode can load hooks and MCP configuration, so the existing isolated runner's restrictions must be preserved and verified for any future adapter. Do not use bare mode as a subscription isolation shortcut. [Programmatic use](https://code.claude.com/docs/en/headless).
- `--no-session-persistence` disables resumable session files; it is not a promise that all diagnostics or provider data disappear. [CLI reference](https://code.claude.com/docs/en/cli-reference). Anthropic documents consumer retention of 30 days when model improvement is off and five years when it is on; the setting also affects training use. A hosted option must disclose the applicable policy and verify the chosen account settings before real context is considered. Local removal cannot retract a completed upload. [Data usage](https://code.claude.com/docs/en/data-usage).
- Product integration has additional conditions: unmodified binaries, commercial terms, users authenticating for themselves, and no intermediary payment/resale of their usage. The documented conditions also prohibit restricting built-in authentication methods. Review how a proposed product integration satisfies those conditions and the project's no-API scope before distribution; the personal lab is not evidence that this review is complete. [Product integration conditions](https://code.claude.com/docs/en/legal-and-compliance).
- Cursor documents [browser authentication](https://cursor.com/docs/cli/reference/authentication) and [headless print mode](https://cursor.com/docs/cli/headless). Those capabilities alone establish neither included allowance nor suitability for a distributed meeting companion. No comparable TalkQTE test has been run.

## Proposed session permission boundary

Permission is represented in Rust and is off by default. A frontend click alone must not select an arbitrary executable, destination or source set. The narrow command resolves a known processor configuration and validates the exact scope before a worker can receive anything. Permission is memory-only and expires at session end; it is not a durable preference or permission to train on conversations.

The user reviews a single summary before enabling evaluated cues for that session:

- **Processing:** named processor/model configuration, on-device or hosted destination, and known data-handling policy. An unavailable or unreviewed configuration cannot be enabled. Authentication happens through the provider's normal flow; TalkQTE never collects or extracts its session tokens.
- **Conversation:** whether the most recent eligible transcript lines already present are included, plus new speech arriving during this session. Keep the existing six-line window, source bounds and freshness checks. Microphone permission and processing permission are separate; starting capture does not grant hosted processing.
- **Prior notes:** optional, explicitly reviewed note identities and revisions, with title/provider/date. An import is not consent to send a note elsewhere. Default to no prior notes; adding or revising one must not silently widen the grant. Manual notebook text, raw name/focus settings, unselected notes, transcripts from other sessions, credentials and audio remain excluded.
- **Limits and control:** one worker, bounded request/reply/deadline, no automatic retry or fallback, clear disable/Stop controls. Hosted use consumes the user's allowance; the app must not imply unlimited capacity or a verified remaining allowance it cannot measure.

At dispatch and before applying a reply, validate session, processor configuration and permission generation as well as the engine's eligibility/source checks. A grant cannot authorize changed note revisions, a different destination or a later session. Scope removal revokes pending work and copied disclosure. Scope expansion or a changed processor requires another review; it never starts processing as a side effect of importing notes or signing in.

Pause cues cancels work and suppresses further submissions while capture remains visibly on. An explicit Resume may continue only with the same still-valid grant and newly spoken input. Disabling evaluated processing revokes the grant; it does not pretend to stop the microphone. Stop live session must both revoke processing and follow the existing capture-stop path. No result may revive either state after cancellation. Already transmitted content remains subject to the provider's policy.

## Proposed availability and recovery

An accepted `quiet` decision and an unavailable evaluator are different states. Show availability separately from cue content, without exposing raw provider output or interpreting failure as an answered question.

| Event | Required behavior before activation |
| --- | --- |
| No grant, changed scope, Stop or disabled processing | No dispatch; cancel pending work and release its caller-owned input and cue copies. A new session starts disabled. |
| Invalid or oversized input | No partial upload, truncation or automatic batching. Explain the limit and let the user reduce scope. |
| Cancelled, superseded or stale result | Drop it before display. Coalesce only new eligible speech, never replay intermediate requests. |
| Deadline, malformed reply, missing source or provider failure | No new cue from that result, no retry of that input, and no silent switch to phrase rules or another provider. Revoke processing permission and require a fresh review before more submissions. Keep a content-free unavailable state; clear copied cue evidence without marking it resolved. |
| Missing authentication, exhausted allowance or rate limit | Stop submissions and show the reason. The user may resolve it and explicitly resume; do not sign in, purchase, wait-loop or restart inference automatically. |
| Worker exit or ignored cancellation | No overlapping replacement worker. A provider adapter must prove subprocess/request termination; the current cooperative trait alone does not guarantee it. |

Ordinary local operation remains available. Choosing phrase cues again must be explicit when it changes the active cue mode. A fixed, content-free error code may be kept in session memory; raw input/output, credentials, cue-use labels and diagnostics are not silently retained or uploaded.

## Acceptance and dependency order

1. **Implemented in the development engine:** a provider-independent grant and preflight boundary with fictional adapters ([acceptance](cue-evaluator.md#session-processing-permission)). Headless checks must observe zero adapter calls before consent, after revocation or for a stale session; reject changed destinations/revisions and unapproved notes; preserve approved source metadata; reject oversized input before dispatch; prove delayed replies cannot revive a revoked grant. No model installation or invocation is needed.
2. **Exercised through fictional IPC:** the proposed [controls and availability flow](processing-controls.md) cover source review, processing location, continuing capture, pause, Disable and Stop, with keyboard and narrow-layout checks. Next, implement the native command/event controller and test review binding and cancellation races with fictional adapters. Do not mount the controls or activate a provider until that contract is checked. Native assistive-technology, cross-app and comprehension checks remain separate.
3. Choose an experimental processor and review its complete concrete adapter before requesting any new inference. A manual fictional trial specifies fixtures, maximum calls and deadline, account checks, permitted output and stop conditions. Review implementation isolation and cancellation with a fake child process first. The historical lab batch does not authorize this trial.
4. If that trial is authorized, measure source support, already-answered/topic-shift handling, skipped opportunities, request volume, deadline/cancellation behavior and end-to-end latency under speech and pauses. Compare against the [agreed budgets](budgets.md); CLI completion time alone does not pass them. Do not activate real-context processing on the strength of fixture results.
5. Before any real-context or distributable mode, resolve explicit processing choice, provider terms/settings, account isolation, onboarding and support. Verify Granola prior-note import, live input and writeback separately. Preserve the fictional-preview/Follow GitHub public scope, with no launch or accessibility claim from this plan.

The first two steps are independent engineering work. Later activation and inference remain separate decisions. No TalkQTE user-outcome study has been completed; compare useful participation and listening together, with clarification and reminder conditions separately, before claiming benefit.
