# First-run onboarding and provider keys

23 November 2026. This note records the four-step onboarding flow (`src/components/Onboarding.tsx`) and how it shares the single provider-keys surface (`src/components/ProviderKeys.tsx`, `src/lib/providerKeys.ts`) with **Settings → Your API keys**.

## Backend interface and availability

`src/lib/providerKeys.ts` calls the main-window Tauri commands from PR #408 and PR #411:

- `provider_keys_status()` — reads `{ deepgram, anthropic, anyMissing }`, where each key is `{ state: 'notSet' | 'set' | 'rejected' | 'unreadable', verified: boolean }`. `anyMissing` is true only when a key is `notSet` (an `unreadable` key is not treated as missing).
- `set_provider_key({ provider, key })` — checks key shape in Rust and stores or replaces the key in the macOS Keychain; sends nothing to the provider.
- `test_provider_key({ provider })` — makes one read-only request with the stored key; passing checks set `verified: true` (`Set and checked`), refusals set `state: 'rejected'`.
- `remove_provider_key({ provider })` — deletes the stored key from the Keychain.
- Event `provider-keys:changed` — keeps **Settings → Your API keys** and onboarding step 2 in sync after any change.
- `cue_usage()` — reads `{ model, requests, requestCap, spentMicroUsd, spendCapMicroUsd }` (or `null` before a session uses Anthropic) for the Settings usage status line.

If the desktop key commands are unavailable (rejecting as unknown or returning an invalid payload), onboarding never opens automatically, **Settings → Your API keys** shows `"Your keys could not be read. Try again later."`, and `"Set up TalkQTE again"` is hidden. In browser preview (`!bridge.desktop`), `src/lib/providerKeys.ts` runs its in-memory fake and onboarding does not auto-open.

In Playwright tests, `tests/fixtures/native-provider-keys.ts` is the single native provider-key fixture used by `tests/fixtures/native-microphone.ts`. It defaults to both keys `notSet` on `/` and accepts `?keys=set`, `?keys=unreadable`, `?keys=unreadable-one`, and `?keys=unavailable` to exercise every initial Keychain state.

## What the flow does

On desktop, onboarding opens automatically inside the notebook window (in place of the notebook body) once per launch only when all of the following hold:

- key commands are available (`provider_keys_status()` returns a valid status),
- both Deepgram and Anthropic are `notSet` (if either key is `set`, `rejected`, or `unreadable`, onboarding does not auto-open),
- live transcription is unavailable (`live_status` reports `available: false`), so a development or lab launch that already has its own credentials stays on the notebook,
- setup has not been skipped or finished in this launch, and
- no live session is preparing, running, or active.

The four steps:

1. **Step 1 of 4 — What TalkQTE does:** Explains one quiet source-backed cue beside a live call, states that TalkQTE is in alpha, shows a non-interactive **Fictional example** cue, and presents **Two ways to use TalkQTE** (**Use your own keys** active; **TalkQTE Hosted** shown as coming later and not selectable).
2. **Step 2 of 4 — Your keys:** Reuses `ProviderKeysRows` from `src/components/ProviderKeys.tsx` (Deepgram for transcription and Anthropic for cue decisions), adding plain text naming each provider's dashboard (zero external fetches from the app). Behaviour, accessible names, validation, password clearing, non-echoing, `Save key`, `Test key`, `Remove key`, and `provider-keys:changed` updates are identical to **Settings → Your API keys**.
3. **Step 3 of 4 — macOS permissions:** Informational only. Explains **Microphone** and **Screen & System Audio Recording** and states that macOS asks only when you start a source. Nothing is requested or captured on this screen.
4. **Step 4 of 4 — Start a first session:** Explains the per-session approval sequence (`Start live session` → `Review processing` → `Review selected sources` → `Enable for this session`, naming Deepgram and Anthropic accurately, and `Stop`), with **Go to the notebook** and **Start live session**.

Every step uses a static `Step N of 4` label (no animated progress bar), moves focus programmatically to the step heading (`h2`), offers **Skip setup**, **Back**, and **Next**, opens a focus-trapped **Skip setup for now?** confirmation dialog on `Escape`, and disables all transitions under `prefers-reduced-motion: reduce`. Users can always reopen onboarding from **Settings → Setup walkthrough → Set up TalkQTE again** (placed directly beside **Your API keys**) when key commands are available.

## What is sent over the network

Nothing is sent during onboarding except a key test, and only when the person explicitly presses **Test key**. No external dashboard links are fetched, no permissions are requested during onboarding, and **Settings → Your API keys** labels the per-session Anthropic usage line explicitly as an estimate rather than a bill.

## Checks

Browser checks in `tests/onboarding-keys.spec.ts` run in Chromium and WebKit against the fictional test fixture, covering unavailable key commands, automatic first-run launch, no automatic launch when live transcription is already available, `unreadable` Keychain state not auto-opening, step navigation, heading focus, `Escape` confirmation, key shape rejection messages, password clearing and non-echoing, `Test key` → `Checking…` → `Rejected` → `Replace` → `Set and checked`, unreachable error messages, `Remove key`, `provider-keys:changed` sync, Settings re-entry, keyboard-only operation, `390px` narrow layout without overflow, and reduced motion. `tests/provider-keys.spec.ts` and `tests/keep-meeting.spec.ts` cover **Your API keys** and the export dialog's kept-meeting controls unchanged.
