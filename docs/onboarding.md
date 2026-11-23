# First-run onboarding and service keys

23 November 2026. This note records the four-step onboarding flow (`src/components/Onboarding.tsx`) and the Settings **Service keys** section (`src/components/ServiceKeys.tsx`), wired in `src/lib/keys.ts` to the real own-key Tauri interface from PR #408 (key storage) and PR #411 (per-session cue usage).

## Backend interface and availability

`src/lib/keys.ts` calls the main-window commands from PR #408 and PR #411:

- `provider_keys_status()` — reads `{ deepgram, anthropic, anyMissing }`, where each key is `{ state: 'notSet' | 'set' | 'rejected', verified: boolean }`.
- `set_provider_key({ provider, key })` — checks key shape and stores or replaces the key in the macOS Keychain; sends nothing to the provider.
- `test_provider_key({ provider })` — makes one read-only request with the stored key; passing checks set `verified: true` (shown as **Checked** beside **Set**).
- `remove_provider_key({ provider })` — deletes the stored key from the Keychain.
- Event `provider-keys:changed` — keeps Settings and onboarding in step after any change.
- `cue_usage()` — reads `{ model, requests, requestCap, spentMicroUsd, spendCapMicroUsd }` (or `null` before a session uses Anthropic) for the Settings **This session** estimate (400 requests and an estimated $0.50 cap; the model name is not shown).

Until PR #408 merges into `main`, builds without these Rust commands reject them as unknown; **Service keys** in Settings then reports **Unavailable in this build** instead of **Not set**, and onboarding never opens automatically. When `cue_usage()` is unavailable or returns `null`, **This session** shows its empty estimate state (`0 of 400 Anthropic requests · Est. $0.00 of $0.50`).

In Playwright tests, `tests/fixtures/native-microphone.ts` mocks these commands only when `?keys` is present in the URL; without `?keys`, all commands reject as unknown so default tests exercise the missing-command fallback.

## What the flow does

When key commands are available and both Deepgram and Anthropic are `notSet` (`anyMissing` is true), onboarding opens automatically inside the notebook window (in place of the notebook body) once per launch unless skipped or finished in memory:

1. **Step 1 of 4 — What TalkQTE does:** Explains one quiet source-backed cue beside a live call, shows a non-interactive **Fictional example** cue, and presents **Two ways to use TalkQTE** (**Use your own keys** active; **TalkQTE Hosted** shown as coming later and not selectable).
2. **Step 2 of 4 — Your keys:** Reuses the Deepgram (transcription) and Anthropic (cue decisions) key rows, with plain text naming each provider's dashboard (zero external fetches from the app), password entry that clears immediately after saving and never echoes or stores the secret in React state, `Test`, `Replace`, and `Remove` with inline confirmation, verbatim Rust error messages in row alerts, and plain statements of what each service receives:
   - **Deepgram:** receives the session's audio (microphone or the application you chose), only after you approve cue processing for that session, at most 120 minutes per session; billed to your own Deepgram account.
   - **Anthropic:** receives up to six recent transcript lines, the cue on screen and earlier cues, and your session name if set, for cue decisions — never audio, your notes, or focus lines; billed to your own Anthropic account.
3. **Step 3 of 4 — macOS permissions:** Informational only. Explains **Microphone** and **Screen & System Audio Recording** and states that macOS asks only when you start a source. Nothing is requested or captured on this screen.
4. **Step 4 of 4 — Start a first session:** Explains the per-session approval sequence (`Start live session` → `Review processing` → `Review selected sources` → `Enable for this session`, naming Deepgram and Anthropic accurately, and `Stop`), with **Go to the notebook** and **Start live session**.

Every step uses a static `Step N of 4` label (no animated progress bar), moves focus programmatically to the step heading (`h2`), offers **Skip setup**, **Back**, and **Next**, opens a focus-trapped **Skip setup for now?** confirmation dialog on `Escape`, and disables all transitions under `prefers-reduced-motion: reduce`. Users can always reopen onboarding from **Settings → Setup walkthrough → Set up TalkQTE again** when key commands are available.

## What is sent over the network

Nothing is sent during onboarding except a key test, and only when the person explicitly presses **Test**. No external dashboard links are fetched, no permissions are requested during onboarding, and the Settings **This session** block labels its token-based spend figure explicitly as a local estimate rather than a bill.

## Checks

Browser checks in `tests/onboarding-keys.spec.ts` run in Chromium and WebKit against the fictional test fixture, covering missing-command fallback, automatic first-run launch, step navigation, heading focus, `Escape` confirmation, key shape rejection messages, password clearing and non-echoing, `Test` → `Checking…` → `Rejected` → `Replace` → `Set` + `Checked`, unreachable error messages, `Remove` confirmation, `provider-keys:changed` sync, `cue_usage()` display without model name, Settings re-entry, keyboard-only operation, `390px` narrow layout without overflow, and reduced motion. Native macOS Keychain storage, real provider test requests, and VoiceOver remain unverified until the own-key Rust PRs merge and are tested natively.
