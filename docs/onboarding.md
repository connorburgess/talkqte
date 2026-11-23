# First-run onboarding and service keys

23 November 2026. This note records the four-step onboarding flow (`src/components/Onboarding.tsx`) and the Settings **Service keys** section (`src/components/ServiceKeys.tsx`) built against a typed frontend stub (`src/lib/keys.ts`).

## Stub status

The four Tauri commands (`keys_status`, `keys_set`, `keys_test`, `keys_remove`) and the optional per-session usage read (`keys_session_usage`) do not exist in Rust on this branch yet. They are built by the separate own-key lane, whose first PR replaces the stub backend.

- When the key commands are missing (browser preview, or any build where Rust does not register them), **Service keys** in Settings reports **Unavailable in this build** instead of **Not set**, and onboarding never opens automatically.
- In Playwright tests, `tests/fixtures/native-microphone.ts` implements the stub only when `?keys` is present in the URL; without `?keys`, all key commands reject as unknown so default tests exercise the missing-command behavior.

## What the flow does

When key commands are available and neither Deepgram nor Anthropic has a saved key, onboarding opens automatically inside the notebook window (in place of the notebook body) once per launch unless skipped or finished in memory:

1. **Step 1 of 4 — What TalkQTE does:** Explains one quiet source-backed cue beside a live call, shows a non-interactive **Fictional example** cue, and presents **Two ways to use TalkQTE** (**Use your own keys** active; **TalkQTE Hosted** shown as coming later and not selectable).
2. **Step 2 of 4 — Your keys:** Reuses the Deepgram (transcription) and Anthropic (cue decisions) key rows, with plain text naming each provider's dashboard (zero external fetches from the app), password entry that clears immediately after saving and never echoes or stores the secret in React state, `Test`, `Replace`, and `Remove` with inline confirmation, plus plain statements of what each service receives. Either key may be skipped.
3. **Step 3 of 4 — macOS permissions:** Informational only. Explains **Microphone** and **Screen & System Audio Recording** and states that macOS asks only when you start a source. Nothing is requested or captured on this screen.
4. **Step 4 of 4 — Start a first session:** Explains the per-session approval sequence (`Start live session` → `Review processing` → `Review selected sources` → `Enable for this session`, naming Deepgram and Anthropic, and `Stop`), with **Go to the notebook** and **Start live session**.

Every step uses a static `Step N of 4` label (no animated progress bar), moves focus programmatically to the step heading (`h2`), offers **Skip setup**, **Back**, and **Next**, opens a focus-trapped **Skip setup for now?** confirmation dialog on `Escape`, and disables all transitions under `prefers-reduced-motion: reduce`. Users can always reopen onboarding from **Settings → Setup walkthrough → Set up TalkQTE again** when key commands are available.

## What is sent over the network

Nothing is sent during onboarding except a key test, and only when the person explicitly presses **Test**. No external dashboard links are fetched, no permissions are requested during onboarding, and the Settings **This session** block labels its token-based spend figure explicitly as a local estimate rather than a bill.

## Checks

Browser checks in `tests/onboarding-keys.spec.ts` run in Chromium and WebKit against the fictional test fixture, covering missing-command fallback, automatic first-run launch, step navigation, heading focus, `Escape` confirmation, password clearing and non-echoing, `Test` → `Checking…` → `Rejected` → `Replace` → `Set`, `Remove` confirmation, Settings re-entry, keyboard-only operation, `390px` narrow layout without overflow, and reduced motion. Native macOS Keychain storage, real provider test requests, and VoiceOver remain unverified until the own-key Rust backend lands.
