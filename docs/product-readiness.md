# Product readiness plan

Status: planning baseline, 8 November 2026. These are requirements and experiments, not implemented capabilities or a release announcement. The [roadmap](../ROADMAP.md) tracks delivery; [PRODUCT.md](../PRODUCT.md#goal-and-first-proof) defines the user outcome.

TalkQTE should help people stay grounded and respond during a conversation through timely, relevant context. Deliver that experience as a dependable companion people can discover, install, use alongside existing tools, and keep up to date with minimal friction. Work toward the defined feature set and whole-product readiness together. A pleasant fictional demo, an integration mock, or a successful build proves only its own narrow behavior.

The current public objective is to explain the idea with a clearly labeled fictional concept preview and invite people to follow development. Downloads, tester recruitment, and a broad launch are not current calls to action. The pilot and distribution stages below remain preparation for later decisions. Saving and note-taking are secondary use cases; a successful preview or first experience need not end in a saved artifact.

## Areas every release must account for

| Area                                  | What readiness means                                                                                        | Next evidence to collect                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User value and scope                  | Relevant context that supports orientation and timely participation while preserving listening              | Matched fictional conversations with and without assistance; compare clarification questions and context reminders separately, recording unsupported, late, and distracting cues   |
| Reliability and scale                 | Bounded memory and work queues; responsive stop/cancel; sustained operation alongside a call                | Set latency, memory, CPU/energy, and recovery budgets on named Macs before the benchmark; test long sessions, overload, device changes, and interrupted work                       |
| Compatibility and accessibility       | Explicit supported OS, hardware, meeting apps, languages, and assistive setups                              | Native focus, Spaces, full-screen, sharing, keyboard, VoiceOver, and permission-denial checks; unsupported cases remain visible                                                    |
| Integrations                          | Supported, scoped connections with provenance, understandable errors, and independent core operation        | Granola capability/authentication decision and a fictional end-to-end adapter test, followed by an explicitly authorized account check                                             |
| Privacy, security, and data lifecycle | Clear input/processing state, protected credentials, chosen retention, reliable deletion, and safe exports  | Follow data from capture/import through storage, logs, diagnostics, deletion, and export; test boundaries and failure cases against [PRIVACY.md](../PRIVACY.md)                    |
| Installation, models, and updates     | An ordinary user can install, try, upgrade, recover, and uninstall without a development environment        | Clean-machine install and upgrade tests; interrupted model downloads, integrity checks, low disk space, compatible model versions, and recovery without losing saved work          |
| Discovery and onboarding              | Explain the concept and invite following development now; prepare a short path to supported first use later | Review whether the fictional preview communicates timely context without implying live functionality; later, observe supported setup and record time, abandonment, and help needed |
| Support and operation                 | Known limitations, release notes, troubleshooting, a support route, and a response plan for failed releases | Rehearse a failed update/provider outage; offer user-reviewed diagnostics without meeting content; assign a release/support owner                                                  |
| Sustainability                        | A viable cost and maintenance model as usage grows                                                          | Estimate artifact/model download bandwidth, storage, signing/release operations, optional provider costs, and support effort; review dependency/model terms before distribution    |

Budgets and minimum supported hardware are [agreed as targets](budgets.md), pending confirmation runs. Release ownership, pricing, and channel targets remain open decisions. Define them for the intended pilot before declaring a candidate ready. More downloads or feature count alone do not prove user value or operational readiness.

## Production and scaling approach

Keep the accepted [Rust/Tauri boundaries](architecture.md). The core meeting workflow is planned to run locally. Scaling therefore starts with predictable device resource use, a tested compatibility matrix, dependable delivery of app/model files, and manageable support demand.

Plan bounded buffers, cancellation, backpressure, and recovery where each pipeline stage is introduced. Version persisted data and model interfaces when those features are implemented, with migration and recovery tests. Avoid silent cloud fallback when local processing fails. Measure stable-transcript and still-useful-question latency separately.

Evaluate static release artifacts and update metadata before adding a custom service. Tauri's [updater documentation](https://v2.tauri.app/plugin/updater/) supports static JSON and signed update artifacts; this is a feasible starting candidate, not an implemented updater. Plan update deferral during meetings, key custody, interrupted installation recovery, and a tested route to a known-good release. A code rollback must not assume a data migration is reversible.

For any proposed backend, record the unmet need, expected load, data boundary, latency target, cost model, failure behavior, and maintenance owner first. Introduce hosted infrastructure when this evidence warrants it. Revisit bandwidth, rate limits, and support capacity at pilot and wider-release reviews; the [operating estimates](operating-estimates.md) record the first measured sizes.

## Integration readiness

Start planning now. Keep previous-note import, live transcript input, and provider writeback as independent capabilities. A successful read does not validate live input or mutation support.

The first Granola slice should let a user select a small prior-note context, see its source and date, and remove it. Evaluate whether that context helps them stay grounded in the current conversation. It must remain distinguishable from live meeting evidence. Keep the existing note-taker as the primary record; the local core should remain usable when disconnected. Saving generated prompts or writing them back is not required to establish this value.

The note-taker can record the actual discussion without a second manual saving workflow in TalkQTE. Unused suggestions should expire with their context, not silently become meeting facts, decisions, or action items. Keep prompt lifecycle state separate from the meeting record. A retained cue or provider writeback needs a demonstrated use case; do not treat automatic archiving as the default replacement for a Save button.

| Candidate            | Official documentation checked on 8 November 2026                                                                                                                           | Decision still needed                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Granola API          | [Scoped note/transcript/summary access](https://docs.granola.ai/help-center/sharing/integrations/granola-api); API-key creation is documented for Business/Enterprise       | Intended users' entitlement, least-privilege scopes, native credential handling, and supported read endpoints                             |
| Granola MCP          | [Individual-user OAuth and custom-client requirements](https://docs.granola.ai/help-center/sharing/integrations/mcp); available tools depend on plan and workspace settings | Whether a native client offers a simpler supported connection than an API key or selected export; verify exact tools and account behavior |
| Fireflies live input | [Beta WebSocket transcript events](https://docs.fireflies.ai/realtime-api/overview) with a token and transcript ID                                                          | Actual access, quotas, event ordering/revisions, latency, and reconnect behavior                                                          |

**Plan decision, 9 November 2026:** the owner uses Granola's free Basic plan, so the Business/Enterprise API is not available, and the first connection should be Granola MCP with the user's own sign-in. Granola's [MCP documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp) says Basic-plan users can query only notes from the last 30 days, and that MCP availability is time-limited and may change before general release. Third-party guides say Basic lacks transcript access; this is not confirmed in official documentation. Before building the adapter, confirm whether a native third-party MCP client is permitted, which tools Basic exposes, and the authorization flow. The [source-aware contract](architecture.md) already treats import, live input, and writeback as separate capabilities.

These pages establish documented options, not working TalkQTE integrations. The reviewed Granola pages do not establish a live transcript stream or provider writeback path. Recheck official interfaces when implementing; do not depend on scraping another app's private store.

Define the smallest source-aware adapter contract with the first slice: provider/source identity, source date, selected content, revision, capability, and connection status. Keep authentication and provider mapping behind the existing native boundary. Use fictional fixtures for repeated imports, expired/revoked credentials, empty results, rate limits, interrupted requests, and deletion/disconnect. Specify bounded retries and cancellation. For live sources, add duplicate/out-of-order events and transcript revisions before enabling them.

The first version of this contract is `src-tauri/src/context.rs`. Each imported note carries its provider, source ID, title, date, an excerpt of up to 2,000 characters, and a revision. Each connection reports separate import, live-input, and writeback capabilities, and a status: not connected, connected, expired, revoked, rate limited, or unavailable.

Fetching happens outside the in-memory store, which keeps at most 20 notes. Behavior the tests check with in-code fictional notes and a scripted source:

- **Selection:** only notes the user selected, with a real date and some text, are accepted. Others are counted as rejected.
- **Repeated imports:** a note is replaced only by a newer revision, so it's never duplicated or rolled back. Notes beyond the limit are counted separately.
- **Expired or revoked access:** stops at once, with no retry.
- **Interrupted requests:** retried up to three attempts, waiting 1 s and then 2 s.
- **Rate limits:** a provider's wait is honored up to 30 seconds, never longer.
- **Cancellation:** discards the results of a request already in progress, and cuts a wait short when the caller's wait checks for a cancel.
- **Removal:** removing a note deletes its copy. Removing all of a provider's notes is its own action, separate from disconnecting, which must only stop future access, as [PRIVACY.md](../PRIVACY.md) requires. No disconnect operation exists yet.

There are no adapter fixtures in a real provider format, no adapter, authentication, network request, or user interface, and imported notes are not yet shown or used for cues.

An integration is ready only after a user can connect, understand access, select context, recover from a failure, disconnect, and manage imported copies. A mock is preparation; account-level validation and the full user flow are separate release gates. Any writeback needs a verified endpoint plus reviewed content and destination.

## Distribution and first use

Plan both how people find TalkQTE and how they receive a maintained application.

| Channel                                                     | Initial role                                                                                     | Gate before using it                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| talkqte.com                                                 | Explain a labeled fictional concept now, with “Follow development on GitHub” as the primary link | Distinguish intended context/response assistance from the phrase-based prototype; keep links few and relevant; no save/export step required                                                                     |
| Website-linked versioned release downloads                  | Later delivery of a supported application                                                        | Tested installable artifact, clear release status, release notes, privacy information, and support path; no download call to action now                                                                         |
| Invited pilot and relevant Mac/meeting-workflow communities | Later evaluation of setup and first useful experience                                            | Readiness review, consent to participate, a bounded supported scenario, a feedback route, and an explicit recruitment/outreach decision; do not recruit from the current site                                   |
| Granola/Fireflies ecosystem content or partnerships         | Reach people with an existing note-taking workflow                                               | A verified integration and honest provider-specific guidance; no implied endorsement or partnership                                                                                                             |
| Homebrew Cask                                               | Possible convenient installation route for users who prefer it                                   | Stable maintained artifacts and eligibility review against [Homebrew's acceptance requirements](https://docs.brew.sh/Acceptable-Casks); listing is not guaranteed                                               |
| Mac App Store                                               | Potential additional discovery and installation route                                            | Separate feasibility check for sandboxed capture, companion behavior, model delivery, and review requirements; [Tauri's store guide](https://v2.tauri.app/distribute/app-store/) requires sandbox configuration |

For direct macOS delivery, plan Developer ID signing and notarization using the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/), then test the downloaded artifact on a clean machine. The current ad-hoc development bundle is not this proof. Keep signing credentials outside the repository.

Target first use: understand the purpose and compatibility, install, try the fictional demo without an account or capture permission, then explicitly enable a supported input when ready. Explain model size and storage before downloading; make progress, retry, and cancellation clear. Ask for OS permissions when the chosen action needs them, explain denial recovery, and make Stop easy to find. Keep provider connections optional.

When a later stage is approved, use one bounded acquisition/onboarding experiment at a time. Record the audience, channel hypothesis, supported build, success criteria, observed setup friction, and next decision. Start with participant feedback and manual observations; analytics, forms, paid promotion, and outreach are separate product/execution decisions. Do not collect meeting content to measure conversion.

## Development milestones

Follow the progression from [proof of concept to live AI, connected workflows, and broader availability](initial-rollout.md). Plan reliability, integration, accessibility, and distribution alongside the core experience. A supported macOS release does not have to wait for every later integration or platform; each release must fully deliver the slice it advertises.

## Release stages and acceptance

1. **Development (current):** explain the intended experience with a fictional concept preview and a follow-development link. Establish the support matrix, budgets, integration contract, and install/update plan alongside core development. Prepare a reproducible synthetic validation suite; do not turn release planning into premature recruitment or a download offer.
2. **Live macOS alpha:** complete the supported live slice, including an explicitly chosen AI processing path, dependable Stop/recovery, and repeated meeting-use evaluation. Keep synthetic test evidence separate from observations of usefulness. Apply the [milestone acceptance criteria](initial-rollout.md).
3. **Optional invited pilot:** verify the advertised feature slice end to end, including clean installation, first use, interruption recovery, privacy, accessibility, and a support route. Set acceptance criteria before inviting participants. Test updates between candidate versions before widening the pilot. Include integration tests if the pilot promises a connection.
4. **Wider distribution:** demonstrate useful context and participation without unacceptable listening cost, reliable supported operation, recovery from a failed release, sustainable delivery/support costs, and accurate download/help material. Publish limitations and release notes. Expand channels based on observed fit.

The roadmap's full future feature set need not block a clearly scoped pilot. Each release must deliver its advertised slice completely. Windows is the next planned desktop target. Initial Parallels checks must be followed by validation on the hardware and architectures a release claims to support. Ubuntu/Linux remains exploratory, with a support decision after feasibility and maintenance review. Mobile has a separate live-context and presentation feasibility track. Enterprise deployment, additional providers, and commercial packaging remain separate scope decisions. See the [platform plan](platforms.md); planning a platform does not establish current support.

## How ongoing work uses this plan

At each planning pass, read the current product goal, roadmap, research notes, and this plan. Identify the most important unmet readiness condition for the next milestone, then choose a small task with observable evidence. Record which area it advances, the acceptance check, dependencies, and remaining gap in the relevant PR or roadmap entry. A feature PR need not solve every area; consequential gaps must become named follow-up work.

The next planning deliverables are a pilot support matrix with resource budgets, a Granola connection/capability decision, and a clean-install-to-first-use plan covering signed delivery and updates. Technical feasibility and human-cued interaction validation can proceed alongside them. Review coverage across all areas at milestone boundaries so integration, operations, and distribution keep moving as features grow.
