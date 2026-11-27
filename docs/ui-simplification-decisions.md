# UI Simplification Decision Record

This record summarizes the multi-pass simplification across TalkQTE's desktop React surfaces on `cb/notebook-simplify-ui` (branched from `4c77bf6`). The work preserves Direction C visual identity (White and studio amber, `Manrope Variable` + `IBM Plex Mono`, uniform all-round borders, zero one-sided accent strips) and every existing safety, consent, and native floating-dock guarantee while replacing oversized chrome and redundant text walls with calm, task-first desktop density.

## Control Scale System (`src/tokens.css`)

| Control role                                                  | Before (`4c77bf6`)                | After (`cb/notebook-simplify-ui`)       | Touch / narrow (`<= 520px`, `pointer: coarse`) |
| ------------------------------------------------------------- | --------------------------------- | --------------------------------------- | ---------------------------------------------- |
| Primary / standard buttons & inputs (`--control-h`)           | `44px`–`48px` globally on desktop | `34px`                                  | `44px`                                         |
| Hero session action (`--control-h-lg`)                        | `48px`                            | `38px`                                  | `44px`                                         |
| Compact chips, inline row actions, selects (`--control-h-sm`) | `44px`                            | `30px`                                  | `44px`                                         |
| Icon controls (`--icon-btn`)                                  | `44px`                            | `32px` (`28px` muted row reorder icons) | `44px`                                         |
| Floating companion dock & call/end prompts                    | `44px` (unchanged)                | `44px` (preserved untouched)            | `44px`                                         |

Removing the universal `button { min-height: 44px; min-width: 44px; }` rule on desktop fine-pointer viewports eliminated oversized buttons across sidebars, toolbars, tabs, Ask, Meetings, Settings, and dialogs while keeping full `44px` touch/narrow targets and native dock geometry (`320×76`, `320×232`, `320×276`, `320×160`).

## Before / After by Screen

### 1. Notebook — Ready + Notes & Ready + Ask

- **Before:** Switching to **Ask** before a session rendered a disabled textarea, disabled `Send` button, five explanatory paragraphs, a bordered technical box (`Recent excerpt: 0 lines in scope (capped at 200 lines / 64 KiB)`), and non-functional `View transcript` / `Use latest transcript` controls. Beside it, **Cues · STANDBY** sat inside a permanent grey bordered box above dead space, and a headphone echo warning sat permanently below the Ready heading.
- **After:** When the transcript has 0 lines and no prior answers, **Ask** renders a single calm empty state (`Ask after the conversation starts` + one sentence stating opening Ask sends nothing) and avoids unnecessary `question_scope` lookups until lines arrive. **Cues · STANDBY** renders as an unboxed quiet note directly above folded **This meeting** and **Prior context** disclosures. The headphone echo tip moves into a compact `Audio & headphones tip` `<details>` disclosure. **Start live session** remains the clear primary action paired with its factual sending disclosure.

### 2. Notebook — Live (Unified Session Header, Notes, Transcript, Ask)

- **Before:** Three stacked bands (`MicrophoneControl`, `ProcessingControl`, and `.session-strip.is-live`) plus multi-paragraph disclosures pushed the live workspace and active `CueCard` down the viewport. Live **Ask** showed a separate heavy grounding banner and repeated implementation caps (`200 lines / 64 KiB`) inline beside `Send`.
- **After:** Composed a single unified **Live Session Header** (`.live-header-shell`) while preserving independent component state ownership, ARIA landmarks (`Session`, `Microphone`, `Cue processing`), and a single persistent `ProcessingControl` instance across `Notebook ↔ Settings` (preserving in-progress consent reviews). Steady-state live shows session heading, clock, mic activity, `Pause cues` / `Turn off processing`, and `Stop live session` in one calm band with a single `Routing, input & transcript saving` disclosure; errors, alerts, recovery controls, and consent review expand immediately outside disclosures. Live **Ask** pairs `View transcript` on the header row, uses a compact `2`-row composer with `34px` `Send`, keeps a plain-language recent-excerpt destination line (`Send to <provider> · <model>. Uses the latest N lines from this session.`) at `Send`, and moves exact `200 lines / 64 KiB` caps, cost, and retention details into `Transcript scope and cost`.

### 3. Notebook — Ended & Error Recovery

- **Before:** Ended right rail displayed a permanent grey bordered box (`Cues have stopped.`) matching standby clutter; post-session cards stretched awkwardly with oversized controls.
- **After:** Ended standby **Cues** matches Ready standby as quiet unboxed text; **Meeting notes** and **Saved to Meetings / Keep this meeting** sit cleanly at natural height with `34px` desktop controls and outcome-named `Export Markdown…`.

### 4. Meetings (List, Folders, Filters, Reorder, Detail)

- **Before:** Two full-width date inputs and an instruction paragraph consumed more vertical space above the fold than content, and every row rendered six simultaneous bordered controls (`Drag`, `Move up`, `Move down`, card border, `Archive`, folder `<select>`).
- **After:** Single compact toolbar row (`Search meetings…`, `Filters` toggle with active count badge `Filters (N)`, and `+ New folder`). Opening `Filters` reveals a compact inline filter panel (`From date`, `To date`, `Has notes`, `Show archived`, `Clear filters`) with `Escape` focus return; closing `Filters` while filters are active displays unmistakable amber-ink active-filter chips and a keyboard-accessible `Clear filters` button. List rows lead cleanly with meeting title and metadata inside borderless rows, placing subtle trailing organization controls (`Drag`, `Move up`, `Move down`, folder `<select>`, borderless `Archive`) on one aligned line that brightens on hover, `:focus-within`, or touch/narrow viewports.

### 5. Settings, Onboarding, and Dialogs

- **Before:** Settings rendered a long scrolling wall of all five sections and five permanently expanded equal provider key forms with visible Keychain masks and `Replace` / `Test` / `Remove` rows.
- **After:** Real **Settings category navigation** selects and displays one section at a time (`Providers & keys`, `Cues & companion`, `Capture & prompts`, `Meetings & storage`, `Privacy & setup`) while preserving `#settings-*` hash and in-app deep links. **Providers & keys** opens with a balanced 2-column **Active setup** summary (**Transcription** + **Cues & meeting notes**, tucking optional custom model IDs and meeting-notes model selection under a compact disclosure), followed by 5 compact single-line provider overview rows showing name, role, `Selected` badge, key status, and `Configure` toggle. Missing active keys and any rejected/unreadable key auto-expand; explicit `Replace key`, `Test key`, and `Remove key` safeguards stay intact and keep the row open after actions. Unified `24px` page headings, compact Onboarding footer (`34px` desktop, `44px` narrow) with `:focus-visible` step headings, and tighter `20px` dialogs.

### 6. Floating Dock & Companion Cue States

- **Preserved untouched:** Native dock window geometry, dark surface contrast, `44×44` icon controls, `Stop`, `Pause`, `Transcript and Ask` launcher, and call/end prompt actions remain unchanged.

## Unresolved Items & Future Scope

- **Calendar home integration:** Remains preserved separately on `cb/notebook-calendar-design` (`de9abfe`) and is intentionally excluded from this production simplification pass; no fake calendar data is shown in the app.
- **Native verification:** Browser Playwright suites verify Chromium and WebKit layouts, disclosures, keyboard navigation, and accessibility on stand-ins; native Tauri/macOS WebKit rendering, real audio capture, keychain reads, and real provider calls remain separate native acceptance checks.
