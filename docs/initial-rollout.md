# Development milestones

Planning baseline, 8 November 2026. TalkQTE is progressing from a proof of concept toward a dependable AI meeting companion with supported integrations and broader platform availability. The stages describe intended capabilities, not release dates or a claim that they already work.

**Proof of concept → live AI companion → connected workflows → broader platform availability.**

## 1. Proof of concept

**Current:** the desktop prototype replays fictional dialogue and displays fixed questions from phrase rules. It provides a floating companion, source disclosure, pause, and dismissal. A separate opt-in microphone monitor reports signal activity; it does not transcribe or supply live cues.

**Purpose:** establish a simple interaction for timely context and prompts. One cue appears, the user can inspect or dismiss it, and unused cues pass quietly. Questions are one possible cue type. Saving generated prompts is not part of this flow.

**Next evidence:** evaluate source-grounded AI decisions on a fixed set of fictional conversations. Include useful clarifications, context reminders, already-answered questions, topic changes, ambiguous speakers, transcript corrections, and cases where silence is appropriate. Compare candidate outputs with reviewed expectations, record misses and interruptions, and measure whether decisions arrive while still useful. Automated success alone does not establish a benefit to listening or participation.

See the [cue intelligence plan](cue-intelligence.md) for bounded evaluation, runtime selection, and processing constraints.

## 2. Live AI companion

**Deliver:** a complete macOS path from explicitly enabled meeting audio through transcription and AI cue selection to the floating companion. Keep context inspectable and pause, dismissal, and Stop easy to use. Local transcription and cue reasoning are separate components; the chosen processing path must be clear.

**Acceptance:**

- Both sides of a synthetic call reach the pipeline on a named Mac, OS, meeting app, language, and audio setup.
- Cue outputs are validated, reference available sources, and respond appropriately to answered questions and changed context. The evaluator cannot start capture, export, access files, or invoke tools.
- Permission denial, unavailable audio, device changes, inference failure, and cancellation have defined behavior. Late work cannot revive a stopped session or display an obsolete cue.
- Latency and resource use stay within budgets agreed before testing. Sustained runs remain responsive without a growing backlog.
- Native focus, Spaces/full-screen, screen sharing, keyboard access, readability, and reduced motion are checked on the supported setup.
- Meeting-use evaluation considers relevance, timing, missed opportunities, and the ability to keep listening. A passing build or a large number of generated cues is insufficient.

The next engineering work is the bounded cue evaluator and both-side capture/transcription feasibility. These can proceed alongside each other before connecting the full live path. Rust retains lifecycle and permission control; model choice follows measured quality, timing, privacy, and operating constraints.

## 3. Connected workflows

**Deliver:** supported connections that provide useful context from existing meeting and note-taking tools. Keep previous-note import, live transcript input, and provider writeback as separate capabilities. Plan Granola as the first selected-context candidate and assess other providers where their supported interfaces meet a demonstrated need.

**Acceptance:**

- Each advertised connection uses a verified supported interface and has tested account access, authentication, and capability limits.
- Users can understand permissions, select context, inspect its source and date, disconnect, and manage imported copies.
- Expired credentials, rate limits, repeated or revised input, empty results, and provider outages have bounded, understandable recovery behavior.
- An unavailable integration does not break the core companion. An unused generated cue does not silently become a note, decision, or action item.
- The complete supported flow is exercised with fictional fixtures and an explicitly enabled account check before claiming compatibility.

Integration feasibility and adapter design can proceed during core development. Each connection ships when its advertised behavior works end to end. See the [integration readiness plan](product-readiness.md#integration-readiness).

## 4. Broader platform availability

**Deliver:** maintained releases that people can install, configure, update, and use alongside their existing tools. Start with macOS, then expand to other desktop and mobile platforms where the live input and cue experience can be supported.

**Acceptance:**

- Each release names its supported OS, hardware, meeting apps, languages, and limitations.
- Clean installation, model setup, first use, updates, recovery, and uninstall are tested. Signing and distribution requirements match the advertised delivery route.
- New platforms validate capture, background behavior, cue presentation, accessibility, resource use, and permissions independently. A responsive web layout alone does not establish mobile meeting support.
- Documentation, privacy choices, release notes, troubleshooting, and a feedback/support route are available before widening distribution.
- Runtime access, model terms, delivery costs, and support effort are sustainable for the intended release. A development subscription does not automatically establish a distributable inference service.

A limited alpha can establish installation and usage evidence before wider availability. Expansion depends on validated capabilities and feedback rather than a fixed launch date. See [product readiness](product-readiness.md), the [mobile plan](mobile.md), and the [detailed roadmap](../ROADMAP.md).

## Release discipline

Use fictional conversations for public examples and reproducible tests. Keep actual meeting content, credentials, and private observations outside the public repository. Describe current capabilities separately from intended behavior, and publish only the support claims verified for the released build.

Each milestone advances the same outcome: timely, relevant assistance that helps someone stay grounded and respond while continuing to follow the conversation.
