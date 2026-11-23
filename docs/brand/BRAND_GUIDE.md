# TalkQTE Brand Guide

This document defines the visual, typographic, symbolic, and editorial identity for TalkQTE. Pair it with [index.html](index.html) for self-contained live specimens (notebook, floating companion, website hero, and side-by-side studio comparison) and [tokens.css](tokens.css) for drop-in CSS custom properties.

Exported visual sheets are stored in `docs/brand/images/`:

- [Side-by-side comparison with Seatbelt Labs](images/comparison.png)
- [Direction A: White and evergreen](images/direction-a.png)
- [Direction B: White and ink](images/direction-b.png)
- [Direction C: White and studio amber](images/direction-c.png)

---

## 1. Positioning and Personality

**What TalkQTE is:** A quiet meeting companion that surfaces one timely, source-backed cue beside a live conversation to help keep meetings on target. It runs on the person's own machine beside the call without joining the meeting as a participant. It is in early development, built in public on macOS, with no supported public release and nothing to download yet. Where processing is discussed, TalkQTE states plainly that transcription and cue decisions run on cloud services that the person turns on per session (see [PRODUCT.md](../../PRODUCT.md)).

**What it is not:**

- Not a note-taker or meeting record. Your existing note-taker owns the record of what was said and decided.
- Not an "AI teammate", persona, or mascot.
- Not a privacy, local-first, or on-device product.
- Not a participant in the meeting. Joining a call as a participant is a later stated direction with no design, date, or capability today.

**Core attributes in practice:**

1. **Calm.** Pure white surfaces, open space, quiet 1px rules, and zero visual noise so the tool never competes with the people in the room.
2. **Exact.** Plain, concrete statements paired with verbatim quoted sources and explicit maturity labels. Nothing is embellished or implied.
3. **Fast to read at a glance.** One complete cue in upright, open-aperture sans-serif type with a thin time line and no countdown numbers, understood in under a second without clicking.

**Fixed points:**

- Product name: `TalkQTE` (repository name: `talkqte`).
- Headline: `Stay grounded. Respond in the moment.`
- Base ground: pure white (`#FFFFFF`) in every direction.

---

## 2. Benchmark: Granola and Fireflies

A review of the public home pages of Granola (`granola.ai`) and Fireflies (`fireflies.ai`) shows a meeting-tool category split between literary notepads and loud AI teammates. TalkQTE borrows nothing from either brand.

### Granola

- **What it does well:** One sharp differentiator ("Without a meeting bot") repeated consistently; a clean white base (`#FFFFFF`) with confident display scale; realistic, dense sample notes carried through before, during, and after a call.
- **Where it is generic:** "AI notepad" category framing; art-collage backdrop panels and floating video-call tiles with real faces (the default SaaS launch-page house style); testimonial and logo walls; a stylised illustration window rather than an actual interface.
- **Implication for TalkQTE:** Granola already owns "light serif display on white/cream with an olive pill button and a floating app window". Today's `talkqte.com` (Georgia serif on warm off-white `#f7f6f2`, evergreen pill CTA) sits uncomfortably close to Granola's visual move. TalkQTE must leave Georgia-on-cream and pill buttons behind.

### Fireflies

- **What it does well:** Plain consent and data-use answers in its FAQ ("tell them before you start recording"; vendor training opt-outs) and a structured role-by-role map of use cases.
- **Where it is generic:** Dark starfield-to-sunset gradient hero, category-default violet (`#7a5af8`) glowing CTAs, a named robot mascot ("Fred") with an emoji-style avatar, rotating headline words, an announcement banner, and "100+ integrations" proof walls.

### What this leaves open for TalkQTE

Neither brand designs for **the live moment itself**. Both sell **the record** (notes, summaries, memory) and depict full document windows or dashboards. TalkQTE's product is the opposite: **one small, exact cue beside a live conversation, then nothing.** That leaves wide-open territory for an instrument-grade identity on pure white: upright sans-serif type, monospace provenance metadata, hairline structure, zero gradients or mascots, and **the cue itself** as the signature visual object.

---

## 3. Relationship to Seatbelt Labs

TalkQTE is a product of **Seatbelt Labs** (`seatbeltlabs.com`). A visitor moving from `seatbeltlabs.com/talkqte` to `talkqte.com` or into the macOS app should recognise one studio's craft while feeling an immediate shift in register from studio showcase to quiet live companion.

**Shared studio DNA:**

- **Typography:** Both brands use **Manrope Variable** (upright weights 400 to 600 for display, headings, and body) paired with **IBM Plex Mono** (400 and 500 for status labels, provenance metadata, timestamps, and indices).
- **Structural discipline:** Flat planes separated by `1px` hairline rules, no gradients, no decorative shadows, explicit text maturity labels, and no em dashes in copy.
- **Studio lockup:** The `talkqte.com` footer retains the local Seatbelt Labs SVG lockup (`seatbelt-labs-logo-on-light.svg` and `seatbelt-labs-logo-on-dark.svg`) linking to `https://seatbeltlabs.com/`.

**Deliberate differences:**

- **Ground polarity:** Seatbelt Labs ("Signal & Vacuum") is dark (`#0D1014` Void Carbon) and monumental. TalkQTE is **pure white (`#FFFFFF`) and quiet** so it sits calmly beside daylight productivity tools and live video calls.
- **Wordmark:** Seatbelt Labs uses uppercase `Archivo 800`. TalkQTE uses its own mixed-case `TalkQTE` wordmark in Manrope `700` paired with a dedicated geometric mark.
- **Signature object:** Seatbelt Labs uses an optical light-mote hero and ruled project catalogue. TalkQTE centres on **the cue** (label line, statement, thin Hold time line, and quoted source).
- **Studio project colour:** Seatbelt Labs currently assigns TalkQTE **Solar Amber** (`--project-talkqte: #EBB45B`, light ink `#875500`), alongside Signal Vermilion for Seatbelt, Orbital Cyan for Looptender, and Violet Quartz for Traceweave. Each direction below states explicitly whether it agrees with or departs from that assignment.

---

## 4. Three Colour Directions

Every direction starts on pure white (`#FFFFFF`) with a verified dark-scheme variant for `talkqte.com`. Every ratio below is computed under WCAG 2.1 relative luminance.

### Direction A: White and Evergreen ("Still Water")

Refines TalkQTE's current prototype evergreen (`#203C32` app forest, `#203C3B` site ink) onto a pure white canvas, stripping away warm cream and serif headings while preserving continuity with the existing desktop prototype.

- **Studio amber alignment:** **Departs from the studio's amber assignment.** Keeps TalkQTE's existing evergreen hue instead of Seatbelt Labs' `#EBB45B` / `#875500`.

| Role | Token | Light Name & Hex | Dark Name & Hex |
| --- | --- | --- | --- |
| Primary canvas | `--paper` | Pure White `#FFFFFF` | Deep Forest Night `#0E1513` |
| Alternate band / sidebar | `--band` | Mist Stone `#F4F6F5` | Pine Slate `#131D1A` |
| Cue surface (site / notebook) | `--surface` / `--cue-surface` | White `#FFFFFF` / Pale Eucalyptus `#F2F6F3` | Elevated Pine `#16221E` / `#1B2A25` |
| Primary text | `--ink` | Deep Pine `#162620` | Mist White `#ECF1EE` |
| Inverse button text | `--ink-inverse` | Pure White `#FFFFFF` | Deep Forest Night `#0E1513` |
| Muted text | `--muted` | Slate Pine `#495B54` | Muted Sage `#9FB0A8` |
| Hairline divider | `--line` | Hairline Sage `#DCE3DF` | Dark Pine Rule `#25352F` |
| Interactive border | `--border` | Calibrated Pine `#6E8078` | Muted Moss `#668075` |
| Accent / primary CTA / cue fill | `--accent` / `--accent-ink` | Evergreen `#203C32` | Luminous Evergreen `#7CC4A5` |
| Focus ring | `--focus` | Focus Evergreen `#1D5E47` | Bright Sage `#8FD4B6` |
| Direct-address (`@ Asked you`) | `--cue-asked-edge` / wash | Quiet Terracotta `#9E442A` / `#FAF3EE` | Warm Terracotta `#EE9E7D` / `#261D19` |
| Companion bar (dark chrome) | `--companion-bg` / `-fg` / `-live` | `#203C32` / `#F3F7F5` / `#7CE0A8` | Same dark companion chrome |

**Computed WCAG 2.1 Contrast Ratios (Direction A):**

| Pairing | Light (FG / BG) | Light Ratio | Dark (FG / BG) | Dark Ratio | Result |
| --- | --- | --- | --- | --- | --- |
| Body text on `--paper` | `#162620` / `#FFFFFF` | 15.76:1 | `#ECF1EE` / `#0E1513` | 16.19:1 | AAA |
| Body text on `--band` | `#162620` / `#F4F6F5` | 14.52:1 | `#ECF1EE` / `#131D1A` | 15.09:1 | AAA |
| Body text on cue surface | `#162620` / `#F2F6F3` | 14.45:1 | `#ECF1EE` / `#16221E` | 14.34:1 | AAA |
| Muted text on `--paper` | `#495B54` / `#FFFFFF` | 7.22:1 | `#9FB0A8` / `#0E1513` | 8.15:1 | AAA |
| Muted text on `--band` | `#495B54` / `#F4F6F5` | 6.65:1 | `#9FB0A8` / `#131D1A` | 7.59:1 | AA / AAA |
| Muted text on cue surface | `#495B54` / `#F2F6F3` | 6.62:1 | `#9FB0A8` / `#16221E` | 7.22:1 | AA / AAA |
| Accent-as-text on `--paper` | `#203C32` / `#FFFFFF` | 11.97:1 | `#7CC4A5` / `#0E1513` | 9.07:1 | AAA |
| Accent-as-text on `--band` | `#203C32` / `#F4F6F5` | 11.03:1 | `#7CC4A5` / `#131D1A` | 8.45:1 | AAA |
| Primary button label on fill | `#FFFFFF` / `#203C32` | 11.97:1 | `#0E1513` / `#7CC4A5` | 9.07:1 | AAA |
| Borders on `--paper` / `--band` / cue | `#6E8078` | 4.18 / 3.85 / 3.83:1 | `#668075` | 4.32 / 4.03 / 3.83:1 | AA UI |
| Focus ring on `--paper` / `--band` / cue | `#1D5E47` | 7.65 / 7.05 / 7.02:1 | `#8FD4B6` | 10.80 / 10.06 / 9.57:1 | AAA / AA UI |
| `@ Asked you` label on wash | `#9E442A` / `#FAF3EE` | 5.77:1 | `#EE9E7D` / `#261D19` | 7.65:1 | AA / AAA |
| Companion bar muted / live / focus | `#9DB8AC` / `#7CE0A8` / `#D6EFE1` on `#203C32` | 5.64 / 7.46 / 9.86:1 | Same | Same | AA / AAA |

---

### Direction B: White and Ink ("Quiet Signal")

Strips decorative brand colour out of the interface completely. Surfaces and controls share Seatbelt Labs' neutral Deep Carbon (`#11151B`) and cool vellum scale on pure white; a restrained Live Signal green (`#1B6B45` on light, `#56C68E` on dark) appears **only** for the cue's live state and active capture indicator, so colour has one unmistakable meaning: live right now.

- **Studio amber alignment:** **Departs from the studio's amber assignment.** Adopts the studio's neutral carbon and vellum planes directly, but replaces a product brand hue with a semantic live-state green.

| Role | Token | Light Name & Hex | Dark Name & Hex |
| --- | --- | --- | --- |
| Primary canvas | `--paper` | Pure White `#FFFFFF` | Void Carbon `#0D1014` |
| Alternate band / sidebar | `--band` | Cool Vellum `#F4F6F8` | Instrument Slate `#141920` |
| Cue surface (site / notebook) | `--surface` / `--cue-surface` | White `#FFFFFF` / Alabaster `#F6F8FA` | Elevated Carbon `#181E27` |
| Primary text & primary CTA fill | `--ink` / `--accent` | Deep Carbon `#11151B` | Signal White `#F5F7FA` |
| Inverse button text | `--ink-inverse` | Pure White `#FFFFFF` | Void Carbon `#0D1014` |
| Muted text | `--muted` | Slate Ink `#4E5866` | Telemetry Grey `#9AA4B2` |
| Hairline divider | `--line` | Grid Hairline `#DDE2E8` | Hairline Dark `#252C36` |
| Interactive border | `--border` | Steel Border `#747F8D` | Steel Dark `#67758A` |
| Live-only colour (cue active state) | `--live` / `--cue-fill` | Live Signal `#1B6B45` | Live Mint `#56C68E` |
| Focus ring | `--focus` | Deep Carbon `#11151B` | Signal White `#F5F7FA` |
| Direct-address (`@ Asked you`) | `--cue-asked-edge` / wash | Deep Rust `#9E3E26` / `#FBF4F2` | Warm Rust `#F09278` / `#251A18` |
| Companion bar (dark chrome) | `--companion-bg` / `-fg` / `-live` | `#11151B` / `#F5F7FA` / `#56C68E` | Same dark companion chrome |

**Computed WCAG 2.1 Contrast Ratios (Direction B):**

| Pairing | Light (FG / BG) | Light Ratio | Dark (FG / BG) | Dark Ratio | Result |
| --- | --- | --- | --- | --- | --- |
| Body text on `--paper` | `#11151B` / `#FFFFFF` | 18.31:1 | `#F5F7FA` / `#0D1014` | 17.77:1 | AAA |
| Body text on `--band` | `#11151B` / `#F4F6F8` | 16.90:1 | `#F5F7FA` / `#141920` | 16.45:1 | AAA |
| Body text on cue surface | `#11151B` / `#F6F8FA` | 17.20:1 | `#F5F7FA` / `#181E27` | 15.61:1 | AAA |
| Muted text on `--paper` | `#4E5866` / `#FFFFFF` | 7.21:1 | `#9AA4B2` / `#0D1014` | 7.56:1 | AAA |
| Muted text on `--band` | `#4E5866` / `#F4F6F8` | 6.66:1 | `#9AA4B2` / `#141920` | 7.00:1 | AA / AAA |
| Muted text on cue surface | `#4E5866` / `#F6F8FA` | 6.77:1 | `#9AA4B2` / `#181E27` | 6.64:1 | AA |
| Live green as text on `--paper` / `--band` / cue | `#1B6B45` | 6.49 / 5.99 / 6.10:1 | `#56C68E` | 8.96 / 8.29 / 7.87:1 | AA / AAA |
| Primary button label on fill | `#FFFFFF` / `#11151B` | 18.31:1 | `#0D1014` / `#F5F7FA` | 17.77:1 | AAA |
| Borders on `--paper` / `--band` / cue | `#747F8D` | 4.07 / 3.75 / 3.82:1 | `#67758A` | 4.08 / 3.77 / 3.58:1 | AA UI |
| Focus ring on `--paper` / `--band` / cue | `#11151B` | 18.31 / 16.90 / 17.20:1 | `#F5F7FA` | 17.77 / 16.45 / 15.61:1 | AAA / AA UI |
| `@ Asked you` label on wash | `#9E3E26` / `#FBF4F2` | 6.09:1 | `#F09278` / `#251A18` | 7.20:1 | AA / AAA |
| Companion bar muted / live / focus | `#9AA4B2` / `#56C68E` / `#F5F7FA` on `#11151B` | 7.26 / 8.60 / 17.06:1 | Same | Same | AAA |

---

### Direction C: White and Studio Amber ("Solar Cue" - Recommended)

Brings Seatbelt Labs' assigned TalkQTE colour (Solar Amber `#EBB45B` and Amber Ink `#875500`) directly into a crisp white-first product identity. Neutrals (`#11151B`, `#4F5A68`, `#F3F5F7`, `#D3D9E2`, `#0D1014`) and sharp `2px` control geometry align directly with the studio site. Raw Solar Amber (`#EBB45B`) is **never** used as text on white or light surfaces (1.87:1, FAIL); on light surfaces all accent text, cue indicators, timeline fills, and focus rings use Amber Ink (`#875500`). On dark surfaces (the companion bar, dark-mode `talkqte.com`, and the brand mark), Solar Amber shines cleanly at 10.18:1 against Void Carbon.

- **Studio amber alignment:** **Agrees with the studio's amber assignment.** Directly implements `--project-talkqte: #EBB45B` and `--project-talkqte-ink: #875500`.

| Role | Token | Light Name & Hex | Dark Name & Hex |
| --- | --- | --- | --- |
| Primary canvas | `--paper` | Pure White `#FFFFFF` | Void Carbon `#0D1014` |
| Alternate band / sidebar | `--band` | Drafting Vellum `#F3F5F7` | Instrument Slate `#151A21` |
| Cue surface (site / notebook) | `--surface` / `--cue-surface` | White `#FFFFFF` / Warm Vellum `#F8F7F4` | Elevated Carbon `#181F28` |
| Primary text | `--ink` | Deep Carbon `#11151B` | Signal White `#F5F7FA` |
| Primary button fill / label | `--btn-primary-bg` / `-fg` | `#11151B` / `#FFFFFF` | `#EBB45B` / `#0D1014` |
| Muted text | `--muted` | Slate Ink `#4F5A68` | Telemetry Grey `#9AA4B2` |
| Hairline divider | `--line` | Grid Rule `#D3D9E2` | Hairline Dark `#252C36` |
| Interactive border | `--border` | Calibrated Rule `#737F90` | Steel Dark `#637286` |
| Studio accent (fills, dark UI, cue top rule) | `--accent` | Solar Amber `#EBB45B` | Solar Amber `#EBB45B` |
| Accent as text & timeline fill | `--accent-ink` / `--cue-fill` | Amber Ink `#875500` | Solar Amber `#EBB45B` |
| Focus ring | `--focus` | Amber Ink `#875500` | Solar Amber `#EBB45B` |
| Direct-address (`@ Asked you`) | `--cue-asked-edge` / wash | Vermilion Ink `#A83B12` / `#FDF5F0` | Warm Vermilion `#FF7A4D` / `#251916` |
| Companion bar (dark chrome) | `--companion-bg` / `-fg` / `-live` | `#0D1014` / `#F5F7FA` / `#EBB45B` | Same dark companion chrome |

**Computed WCAG 2.1 Contrast Ratios (Direction C):**

| Pairing | Light (FG / BG) | Light Ratio | Dark (FG / BG) | Dark Ratio | Result |
| --- | --- | --- | --- | --- | --- |
| Body text on `--paper` | `#11151B` / `#FFFFFF` | 18.31:1 | `#F5F7FA` / `#0D1014` | 17.77:1 | AAA |
| Body text on `--band` | `#11151B` / `#F3F5F7` | 16.75:1 | `#F5F7FA` / `#151A21` | 16.28:1 | AAA |
| Body text on cue surface | `#11151B` / `#F8F7F4` | 17.09:1 | `#F5F7FA` / `#181F28` | 15.46:1 | AAA |
| Muted text on `--paper` | `#4F5A68` / `#FFFFFF` | 7.01:1 | `#9AA4B2` / `#0D1014` | 7.56:1 | AAA |
| Muted text on `--band` | `#4F5A68` / `#F3F5F7` | 6.42:1 | `#9AA4B2` / `#151A21` | 6.93:1 | AA |
| Muted text on cue surface | `#4F5A68` / `#F8F7F4` | 6.55:1 | `#9AA4B2` / `#181F28` | 6.58:1 | AA |
| Amber Ink on `--paper` / `--band` / cue | `#875500` | 6.31 / 5.77 / 5.89:1 | `#EBB45B` | 10.18 / 9.33 / 8.86:1 | AA / AAA |
| Raw Solar Amber as text on white (DO NOT USE) | `#EBB45B` / `#FFFFFF` | 1.87:1 | `#EBB45B` / `#0D1014` | 10.18:1 | FAIL on light / AAA on dark |
| Primary button label on fill | `#FFFFFF` / `#11151B` | 18.31:1 | `#0D1014` / `#EBB45B` | 10.18:1 | AAA |
| Dark text on Solar Amber fill | `#11151B` / `#EBB45B` | 9.78:1 | `#0D1014` / `#EBB45B` | 10.18:1 | AAA |
| Borders on `--paper` / `--band` / cue | `#737F90` | 4.06 / 3.72 / 3.79:1 | `#637286` | 3.89 / 3.56 / 3.38:1 | AA UI |
| Focus ring on `--paper` / `--band` / cue | `#875500` | 6.31 / 5.77 / 5.89:1 | `#EBB45B` | 10.18 / 9.33 / 8.86:1 | AA / AAA |
| `@ Asked you` label on wash | `#A83B12` / `#FDF5F0` | 5.91:1 | `#FF7A4D` / `#251916` | 6.50:1 | AA |
| Companion bar muted / live / focus | `#9AA4B2` / `#EBB45B` / `#EBB45B` on `#0D1014` | 7.56 / 10.18 / 10.18:1 | Same | Same | AAA |

---

### Recommendation

**Adopt Direction C: White and Studio Amber ("Solar Cue").**

1. **Coherent studio family without copying the studio:** Seatbelt Labs already identifies TalkQTE with Solar Amber (`#EBB45B` / `#875500`) on `seatbeltlabs.com/talkqte`. Adopting it makes the jump from the studio catalogue to `talkqte.com` to the macOS companion feel unmistakably designed by one hand, while inverting the primary canvas to pure white (`#FFFFFF`) keeps TalkQTE calm and light beside a live call.
2. **Clear visual separation from Granola and Fireflies:** Granola uses olive/chartreuse and literary serif display on white; Fireflies uses violet gradients on dark. Upright Manrope and IBM Plex Mono on pure white with restrained Amber Ink (`#875500`) and Void Carbon (`#0D1014`) occupies completely distinct territory.
3. **Right emotional temperature for a cue:** Amber reads like a quiet warm pilot light coming on only when context matters, then going dark. Evergreen (Direction A) sits too close to the botanical eco-aesthetic Seatbelt Labs retired and adjacent to Granola's olive green. Monochrome Ink (Direction B) is a strong second choice for pure functional minimalism, and shares Direction C's exact neutral surfaces (`#FFFFFF`, `#F3F5F7`/`#F4F6F8`, `#11151B`), so moving between B and C changes only the mark and accent tokens if the owner later prefers colour strictly for live capture state.

---

## 5. Typography

All three directions share one self-hosted typographic pairing: **Manrope Variable** + **IBM Plex Mono** (SIL Open Font License 1.1, self-hosted from `fonts/`, zero remote requests).

**Why this pairing:**

- **Studio alignment:** Matches Seatbelt Labs' primary sans (`Manrope Variable`) and technical metadata face (`IBM Plex Mono`), creating immediate family recognition without borrowing the studio's uppercase `Archivo 800` wordmark.
- **Against the benchmark:** Retires Georgia serif from `talkqte.com`, eliminating the overlap with Granola's light-serif-on-cream editorial look. Unlike Fireflies' DM Sans/Inter combination on gradients, upright Manrope paired with IBM Plex Mono provenance labels reads like a calibrated instrument.
- **Glance legibility:** Manrope's open counters (`a`, `c`, `e`, `s`) and clean medium/semibold weights read cleanly at `17px` to `28px` glance sizes in the companion and notebook. IBM Plex Mono provides tabular alignment for timestamps, elapsed session clocks, and provenance labels.

**Type Scale (preserving product [DESIGN.md](../../DESIGN.md) glance sizes):**

| Role | Family | Size | Weight | Line Height | Tracking |
| --- | --- | --- | --- | --- | --- |
| Wordmark (`TalkQTE`) | Manrope Variable | `18px` site / `22px` notebook | 700 | `1.0` | `-0.025em` |
| Site Hero Display (`h1`) | Manrope Variable | `clamp(31px, 4.6vw, 54px)` | 500 | `1.06` | `-0.038em` |
| Site Section Heading (`h2`) | Manrope Variable | `clamp(24px, 2.8vw, 31px)` | 500 | `1.18` | `-0.03em` |
| Notebook Cue (standard / large) | Manrope Variable | `22px` / `28px` (steps down at >90 and >140 chars) | 600–700 | `1.22` | `-0.015em` |
| Notebook Cue Source (standard / large) | Manrope Variable | `14px` / `16px` | 400 | `1.45` | `0em` |
| Companion Cue (standard / large) | Manrope Variable | `17px` / `21px` | 600–700 | `1.24` | `-0.015em` |
| Companion Cue Source (standard / large) | Manrope Variable | `13px` / `15px` | 400 | `1.42` | `0em` |
| Body Copy (site & notebook) | Manrope Variable | `16px` (`15px` compact rows) | 400 | `1.65` | `0em` |
| Labels, Chips, Provenance, Status | IBM Plex Mono | `11px` to `12px` uppercase | 500 | `1.35` | `0.06em` |
| Session Clock & Counts | IBM Plex Mono / tabular-nums | `12px` to `14px` | 400 | `1.35` | `0em` |

---

## 6. Mark and Wordmark

Today's mark (a speech bubble with an exclamation mark) reads like generic chat or notification alerts, the opposite of a quiet companion that speaks only when helpful. Each direction replaces it with a simple hand-written SVG mark on a `32×32` integer grid designed to stay razor-sharp at `16px` favicon scale on both light and dark browser chrome.

| Direction | Mark Name | Construction (`32×32` viewBox) | Meaning |
| --- | --- | --- | --- |
| **A: Evergreen** | Margin Mark | `#203C32` rounded tile (`rx="7"`), vertical sage thread (`x=8..11`), white cue block (`x=14..24`), sage time line beneath | One calm cue and its time line emerging beside the vertical conversation thread |
| **B: Ink** | Quiet Aperture | `#11151B` tile (`rx="5"`), crisp white open square frame, single `#56C68E` live dot in the open top-right corner | Monochrome instrument at rest; one restrained green point means live |
| **C: Studio Amber** | Calibrated Cue | `#0D1014` studio tile (`rx="3.5"`), opposing white viewfinder corners (`┌` and `┘`), centered `#EBB45B` Solar Amber cue bar | Staying grounded and on target; links visually to Seatbelt Labs' `#0D1014` mark |

**Wordmark:** Mixed-case `TalkQTE` set in `Manrope Variable` weight `700`, `-0.025em` tracking, paired to the right of the mark with a `10px` gap (at `30px` mark height). Never set `TalkQTE` in all-caps Archivo (reserved for `SEATBELT LABS`).

**Sizing, clear space, and dark/light surfaces:**

- **Minimum sizes:** Mark alone `16px × 16px` (favicon / menu bar); mark + wordmark lockup `24px` mark height (`112px` total lockup width).
- **Clear space:** Maintain at least `0.25×` the mark's width (e.g. `8px` around a `32px` mark) free of text, rules, or other logos on all four sides.
- **Light and dark usage:** Every mark carries a `1px` calibrated edge stroke (`#3C5E51` in A, `#363E4A` in B, `#38414E` in C) so the dark tile separates cleanly on dark browser tabs and dark-mode pages without requiring `<style>` blocks inside SVG (preserving strict CSP).

**Do / Don't:**

- **Do** use the square tile at `16px` for favicons and `30px`–`34px` in headers and notebook sidebars.
- **Do** preserve the exact mixed capitalisation `TalkQTE`.
- **Don't** add drop shadows, gradients, glows, or rounded badges around the mark.
- **Don't** recolour the Solar Amber bar (Direction C) or live dot (Direction B) to arbitrary hues.
- **Don't** pair TalkQTE's mark with a speech bubble, microphone cartoon, or mascot.

---

## 7. The Cue as the Signature Element

One visual object links the macOS notebook, the floating companion, and `talkqte.com`: **the cue**. All three surfaces draw the exact same four-part structure from top to bottom:

1. **Label line:** Short plain words stating what the cue is (`Context`, `You could ask`, `Just said`, `Asked you`, `From your notes`, `From your focus`) in uppercase `IBM Plex Mono` (`11px`–`12px`) with a quiet `6px`–`7px` indicator marker (round dot in A and B, crisp `1px`-radius square in C). Dismiss (`×`) sits quietly in the top-right corner (`44×44px` hit target in the app; non-interactive visual glyph on the static website).
2. **Cue statement:** One complete sentence in upright `Manrope Variable` (`600`–`700`, `-0.015em` tracking) at glance size (`22px`/`28px` notebook, `17px`/`21px` companion, `19px`–`22px` site). Never italic, never truncated behind a click.
3. **Thin time line (and Hold control):** A single `3px` horizontal track separating the statement from its source. Its fill narrows quietly as unread time passes, with **no countdown numbers**. In the app, the entire `44px`-tall strip acts as the `Hold` button; hovering or focusing shows `Hold`, and activating fills the line to full width in its muted resting colour (`Held`). On the static site, it renders as a non-interactive proportional bar with a quiet `Hold` tag.
4. **Quoted source (provenance):** Separated beneath the time line. Monospace provenance line (`FROM THE CONVERSATION`, `THIS CONVERSATION · 04:08 · JORDAN`, or `PRIOR NOTE · GRANOLA · 18 NOV`) above the verbatim quote in regular Manrope muted ink. No Save button, no score, no thumbs up/down.

**Direct-address exception (`@ Asked you`):** Default cues never carry a coloured left border. Only a question asked directly to the person by name carries a `4px`–`6px` left edge, an `@` prefix before the label, a faint warm card tint, and `Stays longer · no countdown` in place of the timed bar so it is told apart before reading and without relying on colour alone (matching [DESIGN.md](../../DESIGN.md)).

---

## 8. Layout, Motion, Voice, and Accessibility

### Layout and Components

- **Website (`talkqte.com`):** Pure white (`#FFFFFF`) primary ground alternating with `--band` sections separated by `1px solid var(--line)` hairlines; `1140px` max width; two-column desktop hero (copy left, static cue window right) and two-column section grids (`0.34fr / 0.66fr`) collapsing cleanly to one column on narrow screens. Status chips are quiet `1px`-bordered monospace tags, never coloured badges. Only the `.cue-window` carries one very soft shadow alongside its `1px` border.
- **Desktop app (notebook and companion):** Preserves the real layout documented in [DESIGN.md](../../DESIGN.md): left sidebar (`Notebook`, optional setup, `Settings`), top toolbar, live session strip with visible capture state and `Stop`, split `Notes` / `Transcript` + `A timely question` workspace, and a `320 × 76px` resting companion bar that expands to `232px` (+ `44px` large text) when a cue arrives. (The desktop app keeps its current prototype stylesheet until a brand direction is chosen.)

### Motion

- **Reduced motion first.** Every screen, cue, and control must remain 100% legible and actionable with `prefers-reduced-motion: reduce`.
- **Website (`talkqte.com`):** Zero animations, zero CSS transitions, and no smooth scrolling.
- **Desktop app:** The timings and choreography in [DESIGN.md](../../DESIGN.md) remain authoritative: cues arrive from the left (`200ms` move / `480ms` widen in notebook; `300ms` drawer expansion in companion) without fading in from invisible; words darken in reading order from `>= 55%` strength (`3.2:1` large) or `>= 68%` (`4.6:1` smaller); holding fills the time line over `560ms`; leaving folds away over `190ms`; reduced motion removes animations and steps the time line in four discrete increments. No bounce, pulsing, or celebratory motion.

### Voice and Copy Rules

TalkQTE speaks plainly and accurately, like a thoughtful colleague who respects the room.

- **No em dashes.** Use periods, colons, commas, or parentheses instead.
- **State limits beside capabilities.** Label work honestly (`In source, not yet released`, `Planned`, `Fictional example`). Never claim live benefits without a user study.
- **Never use banned category words:** Do not write "AI-powered", "seamless", "revolutionary", "effortless", "powerful", "first", "unique", "proven", or "guaranteed".
- **Never describe TalkQTE as private, local-first, offline, or on-device.** Cloud transcription and cue decisions are stated plainly where data flow is described.
- **No model names as features.** Never name model versions in marketing copy, hero text, headings, or alt text. Provider names appear only in the data-flow explanation.

| Do | Don't |
| --- | --- |
| "Stay grounded. Respond in the moment." | "Unlock effortless, AI-powered meeting intelligence." |
| "TalkQTE is being built to help keep meetings on target, with the right cue at the right moment. It runs on your own machine beside the call." | "The first local-first, on-device AI teammate that remembers every meeting privately." |
| "Early development, running from source on macOS. There is no supported public release and nothing to download or install." | "Download the revolutionary beta now and join teams shipping seamlessly." |
| "Concept: a fictional example, not the current prototype." | "See how TalkQTE's proven AI engine boosts your call performance." |

### Accessibility

- **Text contrast:** Every body, muted, label, and accent-as-text pairing meets at least **4.5:1** (WCAG 2.1 AA), with primary body ink exceeding **14:1** (AAA) in all directions and both colour schemes.
- **Non-text UI and focus rings:** Every control border, chip border, cue frame, companion glyph, and focus ring meets at least **3:1** on every surface it touches. Keyboard focus uses a `3px solid var(--focus)` outline with `3px` offset and is never suppressed.
- **Reflow and text scaling:** Zero horizontal overflow from `320px` to `1440px`, including at **200% browser text enlargement**. Standalone controls keep a `44px` minimum target height (`48px` primary app actions).
- **No colour-only meaning:** Direct-address cues combine left edge, `@` icon, label text, and tint; status chips use explicit text; companion states that a glyph cannot convey are spelled out in words.
