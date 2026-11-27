# UI Simplification Decision Record

This record summarizes the multi-pass simplification across TalkQTE's desktop React surfaces on `cb/notebook-simplify-ui` (branched from `4c77bf6`). The work preserves Direction C visual identity (White and studio amber, `Manrope Variable` + `IBM Plex Mono`, uniform all-round borders, zero one-sided accent strips) and every existing safety, consent, and native floating-dock guarantee while replacing oversized chrome and redundant text walls with calm, task-first desktop density.

## Control Scale System (`src/tokens.css`)

| Control role | Before (`4c77bf6`) | After (`cb/notebook-simplify-ui`) | Touch / narrow (`<= 520px`, `pointer: coarse`) |
| --- | --- | --- | --- |
| Primary / standard buttons & inputs (`--control-h`) | `44px`–`48px` globally on desktop | `34px` | `44px` |
| Hero session action (`--control-h-lg`) | `48px` | `38px` | `44px` |
| Compact chips, inline row actions, selects (`--control-h-sm`) | `44px` | `30px` | `44px` |
| Icon controls (`--icon-btn`) | `44px` | `32px` (`28px` muted row reorder icons) | `44px` |
| Floating companion dock & call/end prompts | `44px` (unchanged) | `44px` (preserved untouched) | `44px` |

Removing the universal `button { min-height: 44px; min-width: 44px; }` rule on desktop fine-pointer viewports eliminated oversized buttons across sidebars, toolbars, tabs, Ask, Meetings, Settings, and dialogs while keeping full `44px` touch/narrow targets and native dock geometry (`320×76`, `320×232`, `320×276`, `320×160`).

## Before / After by Screen

### 1. Notebook — Ready + Notes & Ready + Ask
- **Before:** Switching to **Ask** before a session rendered a disabled textarea, disabled `Send` button, five explanatory paragraphs, a bordered technical box (`Recent excerpt: 0 lines in scope (capped at 200 lines / 64 KiB)`), and non-functional `View transcript` / `Use latest transcript` controls. Beside it, **Cues · STANDBY** sat inside a permanent grey bordered box above dead space, and a headphone echo warning sat permanently below the Ready heading.
- **After:** When the transcript has 0 lines and no prior answers, **Ask** renders a single calm empty state (`Ask after the conversation starts` + one sentence stating opening Ask sends nothing) and avoids unnecessary `question_scope` lookups until lines arrive. **Cues · STANDBY** renders as an unboxed quiet note directly above folded **This meeting** and **Prior context** disclosures. The headphone echo tip moves into a compact `Audio & headphones tip` `<details>` disclosure. **Start live session** remains the clear primary action paired with its factual sending disclosure.

### 2. Notebook — Live (Notes, Transcript, Ask, Capture, Cue Processing)
- **Before:** Stacked 44–48px buttons and multi-paragraph disclosures inside `MicrophoneControl` and `ProcessingControl` pushed the live workspace and active `CueCard` down the viewport. Live **Ask** showed a separate heavy grounding banner above a tall composer and oversized Send button.
- **After:** `MicrophoneControl` keeps active status, `Stop live session`, active input name, and concise audio routing visible immediately while tucking the multi-line independent transcript-retention policy into `Transcript saving details` (`<details>`), with no nested `<details>` disclosures. `ProcessingControl` tightens its compact live band (`30px` actions) without removing consent review, `Pause cues`, or `Turn off processing`. Live **Ask** pairs `View transcript` on the header row, uses a compact `2`-row composer with `34px` `Send`, keeps the factual authorization/scope line (`Send to <provider> · <model>. Uses the latest N lines (capped at 200 lines / 64 KiB).`) directly beneath the button, and tucks detailed range/cost/retention notes into `Transcript scope and cost`.

### 3. Notebook — Ended & Error Recovery
- **Before:** Ended right rail displayed a permanent grey bordered box (`Cues have stopped.`) matching standby clutter; post-session cards stretched awkwardly with oversized controls.
- **After:** Ended standby **Cues** matches Ready standby as quiet unboxed text; **Meeting notes** and **Saved to Meetings / Keep this meeting** sit cleanly at natural height with `34px` desktop controls and outcome-named `Export Markdown…`.

### 4. Meetings (List, Folders, Filter, Reorder, Detail)
- **Before:** Every row rendered six `44–48px` bordered controls (`Drag`, `Move up`, `Move down`, meeting card, `Archive`, folder `<select>`), creating heavy visual noise and tall rows.
- **After:** Search, date filters, and `New folder` use `34px` desktop inputs/buttons; folder headers tighten to `38px`; row cards tighten padding and typography; `Archive` and inline folder selects use `30px` desktop height; reorder controls (`28px`) rest quietly at reduced emphasis and brighten on row hover or keyboard focus-within, expanding to `44px` on touch/narrow viewports.

### 5. Settings, Onboarding, and Dialogs
- **Before:** `44–48px` buttons and inputs stretched Settings (`ProviderKeys`, jump links, selects, text inputs), Onboarding step footers, and Export / Prior-context chooser dialogs.
- **After:** Unified `24px` page headings across Notebook Ready, Meetings, and Settings; `30px` Settings jump links; `34px` provider inputs, stored-key masks, selects, and action buttons; compact Onboarding footer (`34px` desktop, `44px` narrow) with `:focus-visible` step heading rings; tighter `20px` dialog padding while keeping all confirmation, privacy, and consent copy intact.

### 6. Floating Dock & Companion Cue States
- **Preserved untouched:** Native dock window geometry, dark surface contrast, `44×44` icon controls, `Stop`, `Pause`, `Transcript and Ask` launcher, and call/end prompt actions remain unchanged.

## Unresolved Items & Future Scope
- **Live mode top-bar consolidation:** When both `MicrophoneControl`, `ProcessingControl`, and `.session-strip.is-live` are mounted simultaneously during a live session, three separate bands still render above the workspace (though tightened). Combining live capture + session status into one unified live bar requires aligning existing IPC state boundaries and test fixtures across `MicrophoneControl` and `App.tsx`, deferred to a dedicated follow-up with root review.
- **Calendar home integration:** Remains preserved separately on `cb/notebook-calendar-design` (`de9abfe`) and is intentionally excluded from this production simplification pass; no fake calendar data is shown in the app.
- **Native verification:** Browser Playwright suites verify Chromium and WebKit layouts, disclosures, keyboard navigation, and accessibility on stand-ins; native Tauri/macOS WebKit rendering, real audio capture, keychain reads, and real provider calls remain separate native acceptance checks.
