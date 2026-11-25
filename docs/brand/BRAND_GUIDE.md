# TalkQTE Brand Guide

**Adopted identity (23 November 2026, owner's choice): Direction C, White and studio amber.**

This document records the finalised visual, typographic, symbolic, surface, and editorial identity for TalkQTE. Pair it with [index.html](index.html) for self-contained live specimens (adopted identity, dock states, notebook panel states, and historical comparison) and [tokens.css](tokens.css) for drop-in CSS custom properties.

Exported visual sheets in `docs/brand/images/`:

- [Adopted identity: White and studio amber](images/direction-c.png)
- [Dock (floating companion): all states including call-starting offer, 1x](images/dock.png) and [2x](images/dock-2x.png)
- [Panel (desktop notebook, Your API keys, session sources, echo guard & meeting notes): all states, 1x](images/panel.png) and [2x](images/panel-2x.png)
- [First-run onboarding (4 steps, 390px, states): 1x](images/onboarding.png) and [2x](images/onboarding-2x.png)
- [Keeping a meeting (wide layout, Stop states, review dialog, Not built summary): 1x](images/keeping-meeting.png) and [2x](images/keeping-meeting-2x.png)
- [Two ways to use TalkQTE (website specimen): 1x](images/two-ways.png) and [2x](images/two-ways-2x.png)
- [Designed, not built (empty; shipped screens moved into Dock and Panel): 1x](images/upcoming-screens.png) and [2x](images/upcoming-screens-2x.png)
- [Historical comparison with Seatbelt Labs](images/comparison.png)
- [Not adopted: Direction A (White and evergreen)](images/direction-a.png) and [Direction B (White and ink)](images/direction-b.png)

---

## 1. Positioning and Personality

**What TalkQTE is:** A quiet meeting companion that surfaces one timely, source-backed cue beside a live conversation to help keep meetings on target. It runs on the person's own machine beside the call without joining the meeting as a participant. It is in early development, built in public on macOS, with no supported public release and nothing to download yet. Where processing is discussed, TalkQTE states plainly that transcription and cue decisions run on cloud services that the person turns on per session (see [PRODUCT.md](../../PRODUCT.md)).

**What it is not:**

- Not a note-taker or meeting record. Your existing note-taker owns the record of what was said and decided.
- Not an "AI teammate", persona, or mascot.
- Not a privacy, local-first, or on-device product.
- Not a participant in the meeting. Joining a call as a participant is a later stated direction with no design, date, or capability today.

**Core attributes in practice:**

1. **Calm.** Pure white surfaces, open space, neutral `1px` rules, and zero visual noise so the tool never competes with the people in the room.
2. **Exact.** Plain, concrete statements paired with verbatim quoted sources and explicit maturity labels. Nothing is embellished or implied.
3. **Fast to read at a glance.** One complete cue in upright, open-aperture sans-serif type with a thin time line and no countdown numbers, understood in under a second without clicking.

**Fixed points:**

- Product name: `TalkQTE` (repository name: `talkqte`).
- Headline: `Stay grounded. Respond in the moment.`
- Base ground: pure white (`#FFFFFF`).
- **No one-sided accent borders (hard rule):** Never place an accent border on one side only (left, right, top, or bottom, including inset `box-shadow` strips, pseudo-element bars, or absolutely positioned strip elements) on cards, cues, notes, callouts, alerts, quotes, chips, or list items. A neutral `1px` hairline (`--line`) used as a full-width section or row divider is allowed. Automated checks enforce this rule in both repositories (`scripts/check-brand-borders.test.mjs` for the brand guide specimens, the app border check on the notebook branch, and `tests/borders.spec.js` in the website repository).
- **Future screens follow this guide (owner, 24 November 2026):** every new or changed screen uses Direction C and the shared tokens and components (no new one-off styles), is added to the specimen sheets in `index.html` with all of its states (marked "Designed, not built" until it ships), and passes the one-sided-border check in each repository.

---

## 2. Benchmark: Granola and Fireflies

A review of the public home pages of Granola (`granola.ai`) and Fireflies (`fireflies.ai`) shows a meeting-tool category split between literary notepads and loud AI teammates. TalkQTE borrows nothing from either brand.

- **Granola:** Strong single differentiator ("Without a meeting bot"), clean white base, and realistic dense mock notes; generic in its "AI notepad" framing, art-collage backdrop panels, floating video-call tiles with real faces, and logo/testimonial walls. Because Granola already owns light serif display on white/cream with olive pill buttons, TalkQTE retires Georgia serif, warm cream, and pill buttons.
- **Fireflies:** Clear consent and data-use FAQ and role-by-role use case map; generic in its dark starfield gradient, glowing violet CTAs, robot mascot ("Fred"), rotating headline words, and proof walls.
- **What stays open for TalkQTE:** Neither designs for **the live moment itself**; both sell the record. TalkQTE owns pure white, upright sans-serif clarity, monospace provenance, studio amber warmth, and **the cue itself** as the signature object.

---

## 3. Relationship to Seatbelt Labs

TalkQTE is a product of **Seatbelt Labs** (`seatbeltlabs.com`).

- **Shared studio DNA:** Self-hosted **Manrope Variable** (400 to 700) and **IBM Plex Mono** (400 and 500), Seatbelt Labs' neutral scale (`#0D1014` Void Carbon, `#11151B` Deep Carbon, `#4F5A68` Slate Ink, `#F3F5F7` Drafting Vellum, `#D3D9E2` Grid Rule), sharp `2px` control corners, flat planes separated by `1px` neutral hairlines, no gradients, no em dashes, and the local Seatbelt Labs footer lockup on `talkqte.com`.
- **Studio colour agreement:** TalkQTE adopts Seatbelt Labs' exact project colour assignment: **Solar Amber (`#EBB45B`)** and **Amber Ink (`#875500`)**.
- **Deliberate differences:** Seatbelt Labs ("Signal & Vacuum") is dark (`#0D1014`) and monumental with uppercase `Archivo 800`. TalkQTE is **pure white (`#FFFFFF`) and quiet** beside a live call, uses a mixed-case `TalkQTE` wordmark in Manrope `700` with its own Calibrated Cue mark, and centres on the cue rather than a studio catalogue.

---

## 4. Colour System (Adopted Direction C: White and Studio Amber)

Raw Solar Amber (`#EBB45B`) is **never** used as text or a thin UI border on white or light surfaces (`1.87:1`, FAIL). On light surfaces, all accent text, cue markers, timeline fills, `@ Asked you` all-round borders, and focus rings use **Amber Ink (`#875500`)**. Raw `#EBB45B` is used on dark surfaces (`#0D1014` companion dock bar, dark-mode `talkqte.com`, and the `#0D1014` brand mark) or as a solid fill paired with `#11151B` / `#0D1014` dark ink.

| Role                                         | Token                                         | Light Name & Hex                              | Dark Name & Hex            |
| -------------------------------------------- | --------------------------------------------- | --------------------------------------------- | -------------------------- |
| Primary canvas                               | `--paper`                                     | Pure White `#FFFFFF`                          | Void Carbon `#0D1014`      |
| Alternate band / sidebar                     | `--band`                                      | Drafting Vellum `#F3F5F7`                     | Instrument Slate `#151A21` |
| Cue surface (site / dock card)               | `--surface`                                   | Pure White `#FFFFFF`                          | Elevated Carbon `#181F28`  |
| Cue surface (notebook pane)                  | `--cue-surface`                               | Warm Vellum `#F8F7F4`                         | Elevated Carbon `#181F28`  |
| Primary text                                 | `--ink`                                       | Deep Carbon `#11151B`                         | Signal White `#F5F7FA`     |
| Primary button fill / label                  | `--btn-primary-bg` / `-fg`                    | `#11151B` / `#FFFFFF`                         | `#EBB45B` / `#0D1014`      |
| Muted text                                   | `--muted`                                     | Slate Ink `#4F5A68`                           | Telemetry Grey `#9AA4B2`   |
| Hairline divider (1px neutral)               | `--line`                                      | Grid Rule `#D3D9E2`                           | Hairline Dark `#252C36`    |
| Interactive border (all round)               | `--border`                                    | Calibrated Rule `#737F90`                     | Steel Dark `#637286`       |
| Studio accent (dark UI, mark, dark CTA)      | `--accent`                                    | Solar Amber `#EBB45B`                         | Solar Amber `#EBB45B`      |
| Accent text, marker & timeline fill          | `--accent-ink` / `--cue-fill`                 | Amber Ink `#875500`                           | Solar Amber `#EBB45B`      |
| Held cue resting timeline                    | `--cue-held`                                  | Calibrated Rule `#737F90`                     | Steel Dark `#637286`       |
| Focus ring                                   | `--focus`                                     | Amber Ink `#875500`                           | Solar Amber `#EBB45B`      |
| `@ Asked you` whole-card tint                | `--cue-asked-surface`                         | Warm Amber Wash `#FDF6E9`                     | Dark Amber Wash `#221C12`  |
| `@ Asked you` 1.5px border all round & label | `--cue-asked-border` / `-label`               | Amber Ink `#875500`                           | Solar Amber `#EBB45B`      |
| Inline error banner (surface / ink & border) | `--error-surface` / `--error-ink`             | `#FDF3F0` / `#9C3418`                         | `#261714` / `#FF8E6B`      |
| Dock bar & shell (always dark chrome)        | `--companion-bg` / `-fg` / `-muted` / `-live` | `#0D1014` / `#F5F7FA` / `#9AA4B2` / `#EBB45B` | Same dark chrome           |

**Computed WCAG 2.1 Contrast Ratios (Adopted Direction C):**

| Pairing                                            | Light (FG / BG)                                            | Light Ratio                   | Dark (FG / BG)                                 | Dark Ratio            | Result                      |
| -------------------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ---------------------------------------------- | --------------------- | --------------------------- |
| Body text on `--paper`                             | `#11151B` / `#FFFFFF`                                      | 18.31:1                       | `#F5F7FA` / `#0D1014`                          | 17.77:1               | AAA                         |
| Body text on `--band`                              | `#11151B` / `#F3F5F7`                                      | 16.75:1                       | `#F5F7FA` / `#151A21`                          | 16.28:1               | AAA                         |
| Body text on notebook cue surface                  | `#11151B` / `#F8F7F4`                                      | 17.09:1                       | `#F5F7FA` / `#181F28`                          | 15.46:1               | AAA                         |
| Muted text on `--paper` / `--band` / cue           | `#4F5A68`                                                  | 7.01 / 6.42 / 6.55:1          | `#9AA4B2`                                      | 7.56 / 6.93 / 6.58:1  | AA / AAA                    |
| Accent ink on `--paper` / `--band` / cue           | `#875500`                                                  | 6.31 / 5.77 / 5.89:1          | `#EBB45B`                                      | 10.18 / 9.33 / 8.86:1 | AA / AAA                    |
| Raw Solar Amber as text on white (DO NOT USE)      | `#EBB45B` / `#FFFFFF`                                      | 1.87:1                        | `#EBB45B` / `#0D1014`                          | 10.18:1               | FAIL on light / AAA on dark |
| Primary button label on fill                       | `#FFFFFF` / `#11151B`                                      | 18.31:1                       | `#0D1014` / `#EBB45B`                          | 10.18:1               | AAA                         |
| Borders on `--paper` / `--band` / cue              | `#737F90`                                                  | 4.06 / 3.72 / 3.79:1          | `#637286`                                      | 3.89 / 3.56 / 3.38:1  | AA UI                       |
| Focus ring on `--paper` / `--band` / cue           | `#875500`                                                  | 6.31 / 5.77 / 5.89:1          | `#EBB45B`                                      | 10.18 / 9.33 / 8.86:1 | AA / AAA                    |
| `@ Asked you` body / muted / label on wash         | `#11151B` / `#4F5A68` / `#875500` on `#FDF6E9`             | 17.03 / 6.52 / 5.87:1         | `#F5F7FA` / `#9AA4B2` / `#EBB45B` on `#221C12` | 15.74 / 6.70 / 9.02:1 | AA / AAA                    |
| `@ Asked you` 1.5px border on `--paper` / `--band` | `#875500`                                                  | 6.31 / 5.77:1                 | `#EBB45B`                                      | 10.18 / 9.33:1        | AA UI                       |
| Dock bar muted / live / quiet / focus              | `#9AA4B2` / `#EBB45B` / `#7D8A9B` / `#EBB45B` on `#0D1014` | 7.56 / 10.18 / 5.38 / 10.18:1 | Same                                           | Same                  | AA / AAA                    |

---

## 5. Typography

Both the website and the desktop app use self-hosted **Manrope Variable** (display, headings, body, cues) paired with **IBM Plex Mono** (400 and 500 for labels, status chips, provenance, timestamps, and step counters), bundled under the SIL Open Font License 1.1 with zero remote requests.

The cue's glance sizes in [DESIGN.md](../../DESIGN.md) stay unchanged (`22px` / `28px` notebook, `17px` / `21px` dock companion, stepping down at >90 and >140 characters).

| Role                                     | Family                       | Size                                                            | Weight  | Line Height | Tracking   |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------------- | ------- | ----------- | ---------- |
| Wordmark (`TalkQTE`)                     | Manrope Variable             | `18px` site / `20px` sidebar                                    | 700     | `1.0`       | `-0.025em` |
| Site Hero Display (`h1`)                 | Manrope Variable             | `clamp(31px, 4.6vw, 54px)`                                      | 500     | `1.06`      | `-0.038em` |
| Site Section Heading (`h2`)              | Manrope Variable             | `clamp(24px, 2.8vw, 31px)`                                      | 500     | `1.18`      | `-0.03em`  |
| Notebook Session Heading (`h1`)          | Manrope Variable             | `24px` (`28px` Settings `h1`)                                   | 600     | `1.2`       | `-0.025em` |
| Notebook Panel Heading (`h2`)            | Manrope Variable             | `20px` (`18px` section `h2`)                                    | 600     | `1.3`       | `-0.02em`  |
| Notebook Cue (standard / large)          | Manrope Variable             | `22px` / `28px` (>90 chars: `19px`/`24px`; >140: `17px`/`21px`) | 600–700 | `1.22`      | `-0.015em` |
| Notebook Cue Source (standard / large)   | Manrope Variable             | `14px` / `16px`                                                 | 400     | `1.45`      | `0em`      |
| Dock Companion Cue (standard / large)    | Manrope Variable             | `17px` / `21px`                                                 | 600–700 | `1.24`      | `-0.015em` |
| Dock Companion Source (standard / large) | Manrope Variable             | `13px` / `15px`                                                 | 400     | `1.42`      | `0em`      |
| Body Copy (site & notebook)              | Manrope Variable             | `16px` (`15px` compact rows)                                    | 400     | `1.65`      | `0em`      |
| Labels, Chips, Provenance, Status, Steps | IBM Plex Mono                | `11px` to `12px` uppercase                                      | 500     | `1.35`      | `0.06em`   |
| Session Clock, Counts & Code             | IBM Plex Mono / tabular-nums | `12px` to `14px`                                                | 400     | `1.4`       | `0em`      |

---

## 6. Mark and Wordmark

TalkQTE retires the speech-bubble-with-exclamation-mark glyph in favour of the **Calibrated Cue** mark: hand-written geometric SVG paths on a `32×32` integer grid.

- **Construction:** Void Carbon (`#0D1014`) tile (`rx="3.5"`) with a calibrated `1px` edge stroke (`#38414E`) so it separates cleanly on dark browser chrome without `<style>` tags inside SVG. Inside, two opposing white viewfinder corners (`┌` top-left, `┘` bottom-right in `#F5F7FA`, `2.4px` stroke) frame a centered horizontal **Solar Amber (`#EBB45B`)** cue bar (`11×3`, `rx="1"`).
- **Wordmark:** Mixed-case `TalkQTE` set in `Manrope Variable` `700` (`-0.025em` tracking), `10px` to the right of a `30px` mark. Never set `TalkQTE` in uppercase Archivo (reserved for `SEATBELT LABS`).
- **Minimum sizes & clear space:** Mark alone `16px × 16px` (favicon / menu bar); mark + wordmark lockup `24px` mark height (`112px` width). Clear space is at least `0.25×` the mark's width on all four sides.
- **Do / Don't:** Keep exact `TalkQTE` capitalisation; keep `#0D1014` + `#F5F7FA` + `#EBB45B`; never add drop shadows, glows, gradients, speech bubbles, or mascots.

---

## 7. The Cue as the Signature Element

One object carries identically across the notebook, the floating dock, and `talkqte.com`:

1. **Label line:** Every cue kind is identified by its small square marker (`6px × 6px`, `1px` radius in `--accent-ink` on light / `--accent` on dark) plus its plain label words in `IBM Plex Mono` (`11px` uppercase, `0.06em` tracking). Full list of app cue kinds from `src/components/Question.tsx` (plus `Context` on the website concept preview):
   - `You could ask` (clarification or fixed question)
   - `Suggested` (model suggestion; shown as `Context` on the site concept card)
   - `Just said` / `Said earlier` (quoted commitment or date; no repeated source under it)
   - `Asked you` (direct address by name; see exception below)
   - `Asked the group` (open question to the room)
   - `From your focus` (`Still open` focus reminder)
   - `From your notes` (imported prior-note reminder, with provenance date and optional `Not verified` notice)
     Dismiss (`×`) sits quietly in the top-right corner (`44×44px` hit target in the app; non-interactive glyph on the site).
2. **Cue statement:** Complete, self-contained sentence in upright Manrope (`600`–`700`) at glance size.
3. **Thin time line (and Hold control):** A single `3px` horizontal rule (`1px` radius) between the cue and its source. Proportional fill in `--cue-fill` (`#875500` light / `#EBB45B` dark), with **no countdown numbers**. Activating Hold fills the line to 100% in resting `--cue-held` (`#737F90`) and displays `Held`.
4. **Quoted source (provenance):** Separated by a `1px` neutral `--line` hairline (or sitting cleanly beneath the time line). Monospace provenance (`FROM THE CONVERSATION`, `THIS CONVERSATION · 04:08 · JORDAN`, or `PRIOR NOTE · GRANOLA · 2026-11-01`) above the verbatim quote in regular Manrope `--muted`. When a held cue is answered later, the answering line opens above the original source with a small tick (`✓ Answered later in the conversation`).

**Direct-address exception (`@ Asked you`):** Because being asked by name expects an answer, it must be recognised before reading and without relying on colour alone, while strictly obeying the no-one-sided-border rule:

- Quiet warm tint of the **whole card**: `--cue-asked-surface` (`#FDF6E9` light / `#221C12` dark).
- **Uniform `1.5px` solid border all round** in `--cue-asked-border` (`#875500` light / `#EBB45B` dark). **Never** a left edge bar, top strip, or inset shadow.
- `@` icon directly before `Asked you`, both in `--cue-asked-label` (`#875500` light / `#EBB45B` dark).
- `Stays longer · no countdown` in place of the timed bar (reduced to a plain neutral `1px` hairline rule in compact companion if needed; `Hold` retains the full accessible description).

---

## 8. Dock and Panel Specifications

This section specifies the exact Direction C implementation for the desktop app's two working surfaces, preserving all dimensions from [DESIGN.md](../../DESIGN.md), [docs/glance-mode.md](../glance-mode.md), and [docs/panel-sizing.md](../panel-sizing.md), and all existing wording and structure from the notebook branch.

### 8.1 The Dock (Floating Companion Window)

The dock (`FloatingQuestion`) is an opaque Void Carbon (`#0D1014`) shell anchored beside the meeting. It stays `320px` wide on every display: `320 × 76px` at rest (bar only), `320 × 232px` showing a cue in standard text, and `320 × 276px` (`+44px`) in larger text. Bottom-right placement (default) anchors the bar at the bottom with the cue card above it (`flex-direction: column-reverse`); top presets (`top-center`, `top-left`, `top-right`) and dragged positions anchor the bar at the top with the cue card below it.

**Dock bar states:**

- **Quiet / capturing (Mic on / App audio):** Capture glyph (`Mic` or `AudioLines`, `16px` stroke; muted `#9AA4B2` when quiet, bright `#F5F7FA` on active signal or app audio) + `6px` status dot (`--companion-live` `#EBB45B` when active signal, `--companion-quiet` `#7D8A9B` when quiet), optional `Cloud` / `CloudUpload` glyph (`16px`) when lines leave the device, then `44×44px` icon controls (`Pause`/`Play` filled triangle, outlined `Square` Stop, Lucide `EyeOff` Hide). Words stay in `.visually-hidden` while capture is running so `320px` bars with `44px` targets never collide.
- **Spelled-out states:** `Mic only` (microphone check without a live session; shows Stop + Hide), `Cues off` (detail text `"Mic still on"` or stop reason stays in `.visually-hidden` / tooltip while capturing so three `44px` controls fit cleanly), `Starting…` (with ellipsis, keeping live controls), `Stop requested…` (keeping the mic glyph until capture confirms `off`), and `Status unavailable` (reachable only natively when `microphone_snapshot` fails). Status text uses `Manrope 12px` regular (`--companion-muted`).

**Dock Token, Spacing, and Type Table:**

| Element                                  | Font / Size / Weight                                                                                                                                                                                                      | Colour Token                                                                                                                        | Padding / Size / Radius                                                                                                                            | Border / Rule                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Dock outer shell (`.companion-shell`)    | Inherited                                                                                                                                                                                                                 | `--companion-bg` (`#0D1014`)                                                                                                        | `320px` wide, `6px` outer pad, `18px` radius (flush outer edge)                                                                                    | Uniform `1px solid #252C36` all round + `--shadow-dock`                             |
| Dock bar (`.companion-bar`)              | `Manrope` `12px` regular status; `Manrope` `13px` / `700` bold state title (`Cues off`, `Mic only`)                                                                                                                       | `--companion-fg` title, `--companion-muted` icons/status                                                                            | `min-height: 44px` (resting window `76px`), `2px 2px 2px 12px`                                                                                     | None                                                                                |
| Dock icon control (`.companion-control`) | `16px` Lucide stroke icon (`Pause`, `EyeOff`), `14px` outlined `Square` Stop, filled `Play` triangle                                                                                                                      | `--companion-muted` rest (`7.56:1`), `--companion-fg` hover on `--companion-hover`                                                  | `44 × 44px` (`132px` for three controls), `8px` radius                                                                                             | Focus: `3px solid --companion-focus`, `2px` offset                                  |
| Dock cue card (default)                  | Cue `Manrope` `17px` (`21px` large) / `600`, `1.24` lh; Source `13px` (`15px` large) / `400`, `1.42` lh; Labels `IBM Plex Mono` `10px`–`11px` / `500` kicker (`400` source label) uppercase; `clockTime` `4:08`           | `--surface` (`#FFFFFF`), `--ink`, `--muted`, `--accent-ink` (`#875500`)                                                             | `14px 16px 13px`, `13px` radius; total dock height `232px` (`276px` large); `15px` `×` dismiss inside `44×44px`                                    | Uniform `1px solid --line` all round (no one-sided accent)                          |
| Dock cue card (`@ Asked you`)            | Same glance scale; `@` + `ASKED YOU` in `--cue-asked-label`; `"Stays longer · no countdown"` gives way visually to a `2px` neutral rule in compact dock (kept for assistive technology; words shown visually in notebook) | `--cue-asked-surface` (`#FDF6E9`), `--ink`, `--muted`                                                                               | `14px 16px 13px`, `13px` radius                                                                                                                    | Uniform `1.5px solid --cue-asked-border` (`#875500`) all round                      |
| Dock time line / Hold                    | `IBM Plex Mono` `10px` / `500` `HOLD` (revealed on hover/focus) / `HELD` (always visible once held, including on answered cues)                                                                                           | Track `--line`, fill `--cue-fill` (`#875500`), held `--cue-held` (`#737F90`)                                                        | `3px` track inside `44px` hit target                                                                                                               | None                                                                                |
| Dock answered block                      | `IBM Plex Mono` `10px` tick + `ANSWERED LATER IN THE CONVERSATION`; `Manrope` `13px` quote (sits below retained `HELD` bar)                                                                                               | `--accent-ink` label, `--ink` answer quote                                                                                          | `8px 0 10px`                                                                                                                                       | Neutral `1px solid --line` bottom row divider above original source                 |
| Dock call-starting offer (`CallPrompt`)  | Title `Manrope` `15px` (`17px` large) / `600`, `1.24` lh; buttons `12.5px` (`13.5px` large) primary / `12px` (`13px` large) secondary                                                                                        | `--companion-bg`, `#151A21` card, `--companion-fg`, `--companion-muted`; primary `#EBB45B` / `#0D1014` (`10.18:1`); secondary `#181F28` / `#F5F7FA`; quiet `--companion-muted` (`6.93:1`) | `10px 12px 6px` card inside `6px` shell (`320 × 160px` standard / `204px` large); `22px` Calibrated Cue mark; `44px` targets, `6px` button radius | Uniform `1px solid #252C36` shell & card; `1px solid #637286` secondary button (`3.56:1`) |

**Call-starting offer (`CallPrompt.tsx` & `CallPromptSetting.tsx`):** Shown inside `FloatingQuestion` when no session is running and `When a call starts` (`Offer in the dock when a call seems to start`, on by default on macOS, off in lab runs; `Start automatically` remains off by default) notices another app using the microphone or camera. Never steals focus or auto-starts by default. Compact Direction C card with the `22px` Calibrated Cue mark and a short title (`Call in <App>` for a known meeting app or browser, or `Start listening?` for an unknown app) — no multi-line paragraph. Four controls (`44px` targets): Solar Amber primary **`Start`** (begins listening and processing in one click, or opens the notebook if keys are missing), secondary **`Not now`**, and subtle secondary **`Not for <App>`** (when named) and **`Off`**.

### 8.2 The Panel (Desktop Notebook Working Surfaces)

The notebook moves from warm cream and rounded green pills onto pure white (`#FFFFFF`) with a Drafting Vellum (`#F3F5F7`) sidebar (`248px` default, `>= 200px`), neutral `1px solid --line` (`#D3D9E2`) section dividers, sharp `2px` control corners, Manrope Variable headings and body, and IBM Plex Mono metadata. All wording, control order, disclosures, and resize limits (`Sidebar width` `>= 200px`, `Notes and transcript width` `>= 260px`) match `60ee4b5` on `cb/dock-panel-fidelity`.

**Panel Token, Spacing, and Type Table:**

| Surface / Component                      | Font / Size / Weight                                                                                                                                                                                             | Colour Token                                                                                                                                                                                                                                                                              | Padding / Size / Radius                                                                                                                                 | Border / Rule                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar (`.meeting-list`)                | Wordmark `Manrope` `20px`/`700`; nav `14px`/`500`–`600` with Lucide icons (`Notebook`, `Meetings`, `Settings`); version `IBM Plex Mono` `11px` (`0.1 · alpha`)                                                   | `--band` (`#F3F5F7`), `--ink`, `--muted`                                                                                                                                                                                                                                                  | `248px` default (`>= 200px`), `24px 14px 18px`                                                                                                          | Neutral `1px solid --line` right column divider                                                                                                |
| Active nav item (`.nav-item.selected`)   | `Manrope` `14px` / `600`                                                                                                                                                                                         | `--paper` (`#FFFFFF`) fill, `--ink` text                                                                                                                                                                                                                                                  | `min-height: 44px`, `10px 12px`, `2px` radius                                                                                                           | Uniform `1px solid --border` all round                                                                                                         |
| Toolbar                                  | Breadcrumb `Manrope` `13px`; divider handles resize columns and **Reset panel sizes** lives in **Settings**                                                                                                      | `--paper`, `--ink`, `--muted`                                                                                                                                                                                                                                                             | Toolbar `56px` height, `0 28px`                                                                                                                         | Toolbar `1px solid --line` bottom divider                                                                                                      |
| Microphone check / Live capture bar      | Title `Manrope` `15px` / `600`; status `IBM Plex Mono` `12px`; helper `14px`                                                                                                                                     | `--paper`, `--ink`, `--muted`; active dot `--accent-ink`                                                                                                                                                                                                                                  | `16px 0`, `max-width: 760px` prose                                                                                                                      | Neutral `1px solid --line` bottom divider                                                                                                      |
| Cue processing panel (all states)        | Heading `Manrope` `20px` / `600`; step `IBM Plex Mono` `11px` uppercase (`STEP 1 OF 2`, `STEP 2 OF 2`); review heading `18px` / `600`; `dl` keys `IBM Plex Mono` `12px`                                          | `--paper`, `--ink`, `--muted`; step label `--accent-ink`; warning/issue `--error-ink`                                                                                                                                                                                                     | `16px 0 24px`; `dl` rows `12px 0`                                                                                                                       | Neutral `1px solid --line` top/bottom dividers; `Development build` label uses `1px dashed --line` bottom divider                              |
| Session strip (`.session-strip`)         | `h1` `Manrope` `24px` / `600` (`-0.025em`); subtitle `15px` `--muted`; clock `IBM Plex Mono` `13px` tabular                                                                                                      | `--paper`, `--ink`, `--muted`; live dot `--accent-ink`                                                                                                                                                                                                                                    | `20px 0`                                                                                                                                                | Neutral `1px solid --line` bottom divider                                                                                                      |
| Primary button (`.primary-button`)       | `Manrope` `14px`–`15px` / `600`                                                                                                                                                                                  | `--btn-primary-bg` (`#11151B`), `--btn-primary-fg` (`#FFFFFF`)                                                                                                                                                                                                                            | `min-height: 48px`, `10px 18px`, `2px` radius                                                                                                           | Uniform `1px solid --btn-primary-bg` all round                                                                                                 |
| Secondary button (`.secondary-button`)   | `Manrope` `14px`–`15px` / `600`                                                                                                                                                                                  | `--paper`, `--ink`                                                                                                                                                                                                                                                                        | `min-height: 48px` (`44px` compact), `10px 16px`, `2px` radius                                                                                          | Uniform `1px solid --border` all round                                                                                                         |
| Notes & Transcript tabs                  | `Manrope` `15px` (`600` selected, `400` idle); count `IBM Plex Mono` `12px`                                                                                                                                      | `--ink` active, `--muted` idle                                                                                                                                                                                                                                                            | `min-height: 44px`, `10px 0`; active indicator via `text-decoration: underline` (`2px`, `8px` offset)                                                   | Tab bar `1px solid --line` bottom divider                                                                                                      |
| Notes editor & Transcript rows           | Editor `Manrope` `16px` / `1.75`; footer `IBM Plex Mono` `11px`; speaker `14px` / `600`, timestamp `IBM Plex Mono` `12px`                                                                                        | `--paper`, `--ink`, `--muted`                                                                                                                                                                                                                                                             | Editor `min-height: 220px`; transcript rows `16px 0`                                                                                                    | Transcript rows separated by `1px solid --line`                                                                                                |
| Notebook Cues pane & card                | Heading `Manrope` `16px` / `600`; cue `22px`/`28px`; source `14px`/`16px`                                                                                                                                        | Default: `--cue-surface` (`#F8F7F4`) + uniform `1px solid --border`; `@ Asked you`: `--cue-asked-surface` (`#FDF6E9`) + uniform `1.5px solid --cue-asked-border`                                                                                                                          | `18px 20px 16px`, `8px` radius                                                                                                                          | Uniform all-round border only; `1px solid --line` between timeline and source                                                                  |
| This meeting & Prior context disclosures | Summary `Manrope` `14px` / `600` + count `--muted`; note title `15px` / `600`; provenance `IBM Plex Mono` `11px`                                                                                                 | `--paper`, `--ink`, `--muted`                                                                                                                                                                                                                                                             | Summary `min-height: 44px`, `12px 0`; items `12px 0`                                                                                                    | Neutral `1px solid --line` top/bottom row dividers                                                                                             |
| Settings rows & form controls            | `h1` `28px`/`600`; row `h2` `17px`/`600`; inputs/selects `15px`                                                                                                                                                  | `--paper`, `--ink`, `--muted`; checkboxes `accent-color: --ink`                                                                                                                                                                                                                           | Rows `24px 0`; inputs `min-height: 44px`, `8px 12px`, `2px` radius                                                                                      | Neutral `1px solid --line` row dividers; inputs uniform `1px solid --border`                                                                   |
| Your API keys (`ProviderKeys`)           | Section `h2` `19px`/`600`; provider `16px`/`600`; state chip `IBM Plex Mono` `11px` uppercase; password input `IBM Plex Mono` `13px`; usage line `13px` tabular mono; `Transcription language` `<select>` `15px` | Not set: `--paper` / `--border` / `--muted`; Set (`✓ Saved · checked` / `✓ Saved · not checked yet`): `#FDF6E9` / `--accent-ink` (`#875500`); Checking: `--band` / `--border` / `--ink`; Rejected & Unreadable: `--error-surface` / `--error-ink` (`#9C3418`); focus: `3px solid --focus` | Rows `14px 0`; buttons, select & password input `min-height: 44px`, `2px` radius; This session block `14px 16px` on `--band`; stacks cleanly at `390px` | Neutral `1px solid --line` between rows; uniform all-round borders on chips, inputs, error banners, and session cards (zero one-sided accents) |
| Export dialog (`.export-dialog`)         | `h2` `20px`/`600`; preview `<pre>` `IBM Plex Mono` `13px` / `1.65` on `--band`                                                                                                                                   | `--paper`, `--ink`, `--muted`                                                                                                                                                                                                                                                             | `max-width: 640px`, `24px` pad, `10px` radius                                                                                                           | Uniform `1px solid --border` all round + `--shadow-dock`                                                                                       |
| Session sources (`SessionSources`)       | Legend `Manrope` `14px`/`600`; option labels `14px`/`600` + `13px` `--muted` hints; app scope & headphones `13px`                                                                                                | `--paper`, `--band` app box, `--cue-asked-surface` call-offer notice, `--danger-surface` errors                                                                                                                                                                                           | `16px 0`, app box `12px 16px`, `44px` buttons, `2px` radius                                                                                             | Neutral `1px solid --line` bottom divider; uniform all-round borders on app box, headphones notice, call notice, and error box                 |
| Two-source Transcript & Echo guard       | Labels `You` / `Them` `14px`/`600`; echo chip `IBM Plex Mono` `11px`/`500`; `It was me` / `Remove` `13px`                                                                                                        | `--band` echo card, `--paper` chip, `--danger` outline on `Remove`, `--danger-surface` / `--band` session-strip banners                                                                                                                                                                   | Echo card `12px 14px`, `44px` compact buttons, `2px` radius                                                                                             | Uniform `1px solid --line` on echo card & chip; uniform `1px solid --danger` on `Remove` and stopped-app alert                                 |
| Meeting notes (`MeetingNotes`)           | `h2` `17px`/`600`; `h3` `15px`/`600`; phase chip & field label `IBM Plex Mono` `11px` uppercase; editor/pre `13px` mono; citations `11px` mono                                                                   | `--paper` card & confirm box, `--band` summary/writing/source/kept boxes, `--accent-ink` citations & active chips, `--danger` failed alert & `Discard` / `Remove kept notes`                                                                                                              | `16px` pad, `8px` outer radius / `2px` inner controls, `44px`–`48px` actions                                                                            | Uniform all-round borders everywhere (`1px solid --line`, `--border`, or `--danger`; zero one-sided accents)                                   |

**Your API keys and Transcription language (`ProviderKeys.tsx` on `main`):**

- **Section intro:** Heading `Your API keys`; intro verbatim from `src/components/ProviderKeys.tsx`: _"TalkQTE runs on your own accounts. Live sessions need both keys. Each is kept in your Mac's Keychain and is never shown again. Nothing is sent to either provider until you approve a session's processing review."_ Section-level error (`role="alert"`): _"Your keys could not be read. Try again later."_
- **Rows & states:** Two rows, **Deepgram** (_"Transcribes a live session's audio. Billed by Deepgram per minute, at most 120 minutes per session."_) and **Anthropic** (_"Decides when a cue would help, from recent lines. Billed by Anthropic per token."_). Every state from `ProviderKeys.tsx`:
  - `Checking…` (`!status`), `Not set` (`notSet`), `✓ Saved · not checked yet` (`set`, `verified: false`), `✓ Saved · checked` (`set`, `verified: true`), `Rejected by <Provider>. Replace it with a new key.` (`rejected`), **`unreadable`**: _"Could not be read from the Keychain. Unlock it or allow access, or save the key again."_, and `Unavailable` (when status fails to load). When `set`, a non-editable masked display (`••••••••••••••••••••••••`) is shown with **Replace key** to reveal the replacement input (alongside **Test key** and **Remove key**); `notSet` and `rejected` show the input directly.
  - Inline password form labelled `<Provider> API key` / `Replace <Provider> key` (`Save key` disabled while empty, `Test key` and `Remove key` disabled while not stored or busy; busy labels `Saving…`, `Checking…`, `Removing…`). Clears input on save or error; key is never shown again.
- **This session usage line:** Reads `cue_usage` (`{ provider, model, requests, requestCap, spentMicroUsd, spendCapMicroUsd, customModel }`): _"This session: 12 of 400 cue requests, about $0.03 of $0.50 (an estimate, not your bill), model claude-haiku-5-5."_ For a custom model ID outside the built-in price table, spend fields are `null` and copy reads: _"This session: 7 of 400 cue requests. Estimated spend unavailable for custom model <id>."_ Empty state: _"No session has used your <Provider> key yet."_
- **Cue provider, model & transcription language controls (`CueProviderAndModelChoice`, `LanguageChoice`, and `MeetingNotesModel` inside `ProviderKeys.tsx`):**
  - **Cue & notes provider (`CueProvider`):** `<select>` choosing `Anthropic`, `OpenAI`, or `Gemini` (`anthropic` default); switching providers clears provider-specific custom model IDs. Also configures curated `Cue model` + optional `Custom cue model ID (optional)` (`set_cue_model_override`).
  - **Transcription language (`LanguageChoice`):** `<select>` with `English` (`en`) and `Multilingual` (`multi`), helper text verbatim: _"Applies to the next live session, never one already running. Multilingual follows several languages and switches between them, and Deepgram bills it at a higher rate than English. Phrase-rule cues understand English only; a question that opens with your name and ends in a question mark is noticed in any language; model cues work on what the model understands."_ Error state: _"The language was not changed."_
- **Component boundary:** `src/components/ProviderKeys.tsx` + `src/components/provider-keys.css` (exports `ProviderKeys` for Settings and `ProviderKeysRows` reused in `Onboarding` Step 2), mounted at the top of Settings in `src/App.tsx` (before `"Setup walkthrough"` and `"Your name"`). Holds key rows for **Deepgram**, **Anthropic**, **OpenAI**, and **Gemini**. `Remove key` acts immediately without an inline confirmation drawer. Uses `provider_keys_status`, `set_provider_key`, `test_provider_key`, `remove_provider_key`, `provider_preferences`, `set_cue_provider`, `set_cue_model_override`, `set_notes_model_override`, `transcription_language`, `set_transcription_language`, event `provider-keys:changed`, and `cue_usage`. Sidebar footer version reads `0.1 · alpha`.

---

## 9. Onboarding, Keeping a Meeting, and Two Ways to Use TalkQTE

### 9.1 First-Run Onboarding (`Onboarding`)

Shown inside the notebook window (in place of the notebook body) when no service keys are set, and always reachable again from Settings via **"Set up TalkQTE again"**. See [images/onboarding.png](images/onboarding.png) ([2x](images/onboarding-2x.png)).

- **Structure:** Four single-screen steps with a static monospace indicator (`Step 1 of 4` through `Step 4 of 4`, no animated progress bar), `Skip setup`, `Back`, and `Next` (or terminal actions on Step 4) on every step.
- **Step 1 (What TalkQTE does):** Explains one quiet source-backed cue beside a live call, states that TalkQTE is in alpha, displays the fictional cue specimen (visibly labelled `Fictional example`), and shows the compact **Two ways to use TalkQTE** element (`Free · with your own keys` active with chip `Alpha`; `Pro` shown as `Planned`, `aria-disabled="true"`, not selectable).
- **Step 2 (Your keys):** Reuses the two `ServiceKeys` rows (Deepgram for transcription, Anthropic for cue decisions), each with a **"Where to get one"** line naming the provider's own dashboard in words (_"Deepgram Console (console.deepgram.com) → API Keys"_, _"Anthropic Console (console.anthropic.com) → API Keys"_, zero external fetches from the app), `Add key`, `Test`, `Replace`, `Remove`, and the plain statement of what each service receives. Displays plainly on screen: **"Test is the only action in setup that sends anything over the network, and only when you press it."** Either key can be skipped. Covers `Not set`, `Set`, and `Rejected` states.
- **Step 3 (macOS permissions):** Informational only; **nothing is requested on this screen**. Explains **Microphone** (asked by macOS on first session start) and **Screen & System Audio Recording** (asked by macOS only if choosing an application's audio), why each is needed, and that macOS asks, not TalkQTE.
- **Step 4 (Start a first session):** Explains the exact sequence (`Start live session` → per-session approval: `Review processing` → `Review selected sources` → `Enable for this session`, naming both Deepgram and Anthropic and what each receives; nothing is sent before approval; `Stop` ends capture and sending). Terminal actions: **`Start live session`** (primary) and **`Go to the notebook`** (secondary), alongside `Back` and `Skip setup`.
- **Keyboard, VoiceOver, and motion:**
  - Focus moves programmatically to the step heading `h2` (`tabIndex={-1}`) on every step transition, with a `3px solid --focus` outline.
  - Pressing `Escape` opens a focus-trapped **Skip setup for now?** confirmation dialog (`Keep setting up` / `Skip setup`).
  - `prefers-reduced-motion: reduce` applies zero transitions (`transition: none; animation: none;`).
  - Zero one-sided accent borders; `1320 × 880` notebook frame and `390px` narrow stacked layout both maintain `44px` minimum targets and zero horizontal overflow.
- **Component boundary and typed command interface:** One new component `src/components/Onboarding.tsx` with its own stylesheet `src/components/onboarding.css`, mounted at one mount point in `src/App.tsx` in place of the notebook body while active (plus one Settings row `"Set up TalkQTE again"`). Uses the real own-key commands from PR #408 (`provider_keys_status`, `set_provider_key`, `test_provider_key`, `remove_provider_key`, event `provider-keys:changed`) and PR #411 (`cue_usage`, whose `model` field is never rendered in the UI):

```ts
export type KeyProvider = 'deepgram' | 'anthropic';

export type KeyState =
  | { status: 'not_set' }
  | { status: 'set' }
  | { status: 'checking' }
  | {
      status: 'rejected';
      reason: 'refused' | 'unreachable';
      message: string;
    };

export interface ProviderKeysStatus {
  deepgram: KeyState;
  anthropic: KeyState;
}

export interface CueUsageSnapshot {
  model: string; // Never rendered in This session or Settings UI.
  requests: number;
  requestCap: number; // 400
  spentMicroUsd: number;
  spendCapMicroUsd: number; // 500_000 ($0.50)
}

export interface ServiceKeysBridge {
  provider_keys_status(): Promise<ProviderKeysStatus>;
  set_provider_key(provider: KeyProvider, secret: string): Promise<KeyState>;
  test_provider_key(provider: KeyProvider): Promise<KeyState>;
  remove_provider_key(provider: KeyProvider): Promise<KeyState>;
  cue_usage(): Promise<CueUsageSnapshot>;
  // Emitted by Rust whenever key state changes: 'provider-keys:changed'
}
```

### 9.2 Keeping a Meeting (Design Only)

Designed for people who use TalkQTE on its own without a separate note-taker (such as Granola). Behaviour is implemented by the own-key lane. See [images/keeping-meeting.png](images/keeping-meeting.png) ([2x](images/keeping-meeting-2x.png)).

- **During a session (layout choice & justification):** At wide window widths (`>= 1080px`), `Your notes` and `Live transcript` sit **side-by-side** in two equal bordered panes above a chronological **Shown cues** log (each row listing timestamp, cue kind, and cue text). Below `1080px`, `Your notes` and `Live transcript` collapse back to the existing tabbed layout. _Justification:_ single-app users who do not run a separate note-taker need to scan recent spoken lines while typing notes without toggling tabs mid-call; collapsing below `1080px` preserves comfortable reading widths (`>= 260px`) down to `390px`.
- **At Stop (off by default):** Every session defaults to keeping nothing, stated plainly verbatim: **`"TalkQTE keeps nothing unless you choose Keep this meeting."`**
  - **Without keeping (default):** Ended session strip shows the plain notice, notes that data clears on next session or quit, and offers `Keep this meeting` and `Start live session`.
  - **Review dialog (`Keep this meeting`):** Opens a modal dialog previewing the single combined Markdown document (`# Notes`, `## Shown cues`, `## Transcript`) before the user chooses a file destination (`Cancel` / `Choose destination`).
  - **With keeping (saved):** Confirms the reviewed Markdown filename written to disk while noting that the next session still defaults to keeping nothing.
- **Optional later step (`Not built`):** A clearly separated section below a neutral `1px` divider offers **`Summarise with your Anthropic key`**, visibly badged **`Not built`** with a disabled control and plain text stating that live cue decisions never send your notes or full transcript to Anthropic, whereas this separate unbuilt summary step would send the session's transcript and notes to Anthropic using the user's key, and nothing is sent today.
- **Required documentation & contract update:** Product `main` currently states that the live transcript is never saved or exported. Implementing **Keep this meeting** changes that contract; the own-key lane must update `PRIVACY.md` and `DESIGN.md` alongside the behaviour before shipping.

### 9.3 Two Ways to Use TalkQTE (Free and Pro)

Used both as a two-column section on `talkqte.com` ([images/two-ways.png](images/two-ways.png), [2x](images/two-ways-2x.png)) and as the compact selector element on Onboarding Step 1 (adopted tier names, owner's choice):

- **Free** (`with your own keys` as subtitle or supporting line; small `Alpha` chip, no acronym chip): TalkQTE charges nothing under the Sustainable Use License 1.0 for personal use and internal work (including in your own consulting work). Never say or imply Free is cheaper than other products: heavy users pay Deepgram per minute and Anthropic per token, so state plainly **"you pay Deepgram and Anthropic directly for what you use."** Audio and short recent transcript excerpts go directly from your Mac to Deepgram and Anthropic after per-session approval.
- **Pro** (`Planned` chip): Pay as you go: top up credit and pay per meeting hour, with no keys and no subscription. Audio and text would pass through TalkQTE's service as well as the transcription and cue providers. Not available yet: pricing to be announced, no date, no free allowance, and no extra feature promise beyond pay-as-you-go managed keys and usage.
- **Visual rules:** Two equal-width bordered columns on `talkqte.com`, uniform `1px solid --border` all round (no one-sided accents), no "most popular" badge, no currency amount or rate (at most `"Pricing to be announced"`), and one plain `mailto:connor@seatbeltlabs.com?subject=TalkQTE%20Pro` link on `Pro` (no form, no third-party request). On Onboarding Step 1, `Free` (`Alpha`, _"With your own keys…"_) is active and `Pro` (`Planned`, _"Pay as you go…"_) is dimmed (`aria-disabled="true"`) and not selectable.

### 9.4 Designed, Not Built (Moved to Dock and Panel Sheets)

The three screens previously specified under **Designed, not built** have shipped in Direction C and moved into the adopted sheets ([images/dock.png](images/dock.png) / [2x](images/dock-2x.png) and [images/panel.png](images/panel.png) / [2x](images/panel-2x.png)); `#upcoming-spec` ([images/upcoming-screens.png](images/upcoming-screens.png) / [2x](images/upcoming-screens-2x.png)) now stands ready for future unbuilt designs:

1. **Session start with sources (`SessionSources.tsx`, Panel 14):** Mounted directly below `.session-strip` before a live session starts (`Listen to`: `Microphone`, `Microphone and one application`, `One application only`). Selecting an application mode opens a Drafting Vellum (`--band`) box with the optional call-offer preselect banner, the scope notice for macOS Screen & System Audio Recording, a boxed headphones recommendation when both sources are chosen, `List applications` / `Cancel listing` / `List again`, bundle-ID matching, and uniform `--danger` error banners.
2. **Two-source transcript, echo guard & call setting (Panel 15):** A two-source session labels lines `You` (microphone) and `Them` (application audio) with the plain disclaimer that labels say where a line was heard, not who said it. Session-strip notices style stopped-application alerts (`role="alert"`) in `--danger-surface` and echo counts (`role="status"`) in `--band`. Suppressed lines sit in a Drafting Vellum uniform-bordered card badged `Likely an echo of Them · not used for cues` with `It was me` and danger-outlined `Remove`. Settings mounts `When a call starts` (`CallPromptSetting.tsx`, dock offer on by default on macOS, auto-start off by default, with `Offer for these again` when apps were excluded).
3. **Call-starting offer (`CallPrompt.tsx`, Dock Section 5):** Void Carbon `320 × 160px` (`204px` large) compact dock card with the Calibrated Cue mark, short title (`Call in <App>` or `Start listening?`), Solar Amber primary **`Start`**, secondary **`Not now`**, and subtle **`Not for <App>`** and **`Off`** controls.
4. **Meeting notes (`MeetingNotes.tsx` & `MeetingNotesModel.tsx`, Panel 16):** Offered once after a live session with a transcript ends. Confirmation sits in a pure-white uniform-bordered card (`Send this meeting to <Provider>?` for Anthropic, OpenAI, or Gemini) with the off-by-default `Also send my notes` checkbox and a Drafting Vellum summary box showing destination, care level and model (`Notes setting`), and either estimated cost range + cap (for built-in models) or `"Estimated cost unavailable for custom model..."` (for custom model IDs). Covers idle, confirmation (`Nothing sent yet`), writing (`Writing notes…` + `Stop waiting`), editable draft (`Editable draft` + `Where each item came from` with Amber Ink citations + `Keep with this meeting` / danger-outlined `Discard`), kept (`Kept` + `<pre>` + `Remove kept notes`), failed (`Failed` alert), discarded (`Discarded`), and `Model for meeting notes` + `Custom meeting notes model ID (optional)` inside `ProviderKeys` in Settings.

---

## 10. Motion, Voice, and Accessibility

### Motion and Hover States

- **Reduced motion first.** Every screen, cue, and control stays fully readable and operable under `prefers-reduced-motion: reduce`, with zero running animations and zero transition durations anywhere (instant hover states and a static `62%` cue bar on `talkqte.com`).
- **Website (`talkqte.com`):** No smooth scrolling and zero scripts. Motion is strictly scoped to three CSS-only elements:
  - **Hero cue time line:** `@keyframes cue-time-run` (`18s linear infinite`, `transform: scaleX(1)` to `scaleX(0)` from `0%`–`88%`, brief empty hold `88%`–`97%`, crisp reset to full at `100%`, `transform-origin: left center`). Pauses on `.cue-window:hover` and `:focus-within` (as Hold does). Zero layout shift; nothing is conveyed by motion alone.
  - **Button hover (studio sweep):** Left-to-right fill sweep via `linear-gradient` `background-size` (`0% 100%` right to `100% 100%` left over `200ms cubic-bezier(0.65, 0, 0.35, 1)` on `background-size`, `color`, `border-color`), matching Seatbelt Labs' sweep pattern. **No text underline on button hover.** Label vs fill contrast stays `>= 10.18:1` (`>= 4.5:1`) in both rest and hover states across light and dark modes (Light primary: `#FFFFFF`/`#11151B` ↔ `#11151B`/`#FFFFFF` `18.31:1`; Light secondary: `#11151B`/`#FFFFFF` ↔ `#FFFFFF`/`#11151B` `18.31:1`; Dark primary: `#0D1014`/`#EBB45B` ↔ `#EBB45B`/`#0D1014` `10.18:1`; Dark secondary: `#F5F7FA`/`#0D1014` ↔ `#0D1014`/`#F5F7FA` `17.77:1`). `:focus-visible` retains the `3px solid --focus` outline unreplaced by hover.
  - **Text link hover:** Keeps the underline and transitions `color`, `text-decoration-color`, `text-underline-offset`, and `text-decoration-thickness` over `150ms ease` (`<= 250ms`).
- **Hero framing:** No status eyebrow sits above the hero `h1` headline on `talkqte.com`; alpha is stated once in the hero body line beneath the headline.
- **Desktop app:** Every timing in [DESIGN.md](../../DESIGN.md) stays authoritative: notebook cue arrival (`200ms` move / `480ms` widen), dock drawer expansion (`300ms`, source follows `90ms` later), word darkening from `>= 55%` (`3.2:1` large) or `>= 68%` (`4.6:1` smaller), Hold fill (`560ms`), answer arrival (`380ms`), cue fold leave (`190ms`; macOS dock waits `220ms`), and four-step time line under reduced motion. No bounce, pulsing, or celebratory animation.

### Voice and Copy Rules

TalkQTE writes plainly and accurately, stating limits beside capabilities.

- **No em dashes.** Use periods, colons, commas, or parentheses instead.
- **Honest maturity labels:** Always label capabilities plainly (`In source, not yet released`, `Planned`, `Fictional example`). Never claim unproven meeting benefits.
- **Prohibited marketing terms:** Never use "AI-powered", "seamless", "revolutionary", "effortless", "powerful", "first", "unique", "proven", or "guaranteed".
- **Data-flow honesty:** Never describe TalkQTE as private, local-first, offline, or on-device. State cloud transcription and cue processing plainly in data-flow copy; never list model names as product features.

### Accessibility

- **Contrast:** All text meets `>= 4.5:1` (`>= 15:1` primary ink); all interactive borders, dock glyphs, and focus rings meet `>= 3:1` on every surface they touch.
- **Focus:** `3px solid var(--focus)` (`#875500` light, `#EBB45B` dark) with `3px` offset (`2px` inside the dark dock), never suppressed.
- **Reflow & targets:** Zero horizontal overflow from `320px` to `1440px`, including at `200%` text size. Controls maintain `44px` minimum target height (`48px` primary app actions).
- **No colour-only meaning:** `@ Asked you` pairs whole-card warm tint, uniform `1.5px` all-round border, `@` icon, explicit label, and `Stays longer · no countdown`; dock states spell out what a glyph alone cannot show.

---

## Appendix: Directions Considered (Not Adopted)

During the 23 November 2026 identity review, two other white-base directions were explored alongside Direction C and documented in [index.html](index.html) (labelled _Not adopted_) and [tokens.css](tokens.css) (`[data-direction='a']` and `[data-direction='b']`):

- **Direction A: White and evergreen ("Still Water", not adopted).** Refined the prototype's evergreen (`#203C32` accent, `#162620` Deep Pine ink, `#F4F6F5` Mist Stone band, `#1D5E47` focus, `#0E1513` dark ground, `6px` control corners, Margin Mark) onto pure white `#FFFFFF`. Not adopted because forest green on white sits closer to Granola's olive cue and to the eco-editorial palette Seatbelt Labs retired, and departs from the studio's assigned amber.
- **Direction B: White and ink ("Quiet Signal", not adopted).** Used strictly neutral carbon ink (`#11151B` ink and buttons, `#4E5866` muted, `#F4F6F8` Cool Vellum band, `#0D1014` dark ground, `4px` corners, Quiet Aperture mark) on pure white `#FFFFFF`, reserving restrained green (`#1B6B45` light / `#56C68E` dark) solely for live cue state. Not adopted because Direction C preserves the same neutral carbon/vellum discipline while aligning directly with Seatbelt Labs' Solar Amber identity on `seatbeltlabs.com/talkqte`.
