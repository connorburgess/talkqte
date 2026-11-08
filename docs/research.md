# Research and product decisions

Reviewed 8 November 2026. This is the short entry point for evidence used in TalkQTE. The [product goal](../PRODUCT.md#goal-and-first-proof) is the source of truth for scope; the [roadmap](../ROADMAP.md) distinguishes implemented work from planned work.

## The short version

- **Help the user participate while still listening.** One useful clarification matters more than generating lots of prompts. This is the product goal, not a measured result.
- **Keep a question easy to read and under the user's control.** The prototype shows the complete question first; opening **Why?** reveals its source and keeps it available. This default is a design choice to evaluate.
- **Near-camera placement is an option, not a promise of invisible reading.** Gaze studies use different setups and do not establish one universally correct location for a live prompt.
- **Looking away is normal.** Eye contact is not an attention, honesty, or participation score. People differ in what feels comfortable and lets them listen.
- **Prove the core experience before expanding it.** Live transcription, prompt relevance, accessible controls, and native meeting behavior need validation before broader claims or integrations.

## What we use, and why

| Decision | Evidence or rationale | Status and next check |
| --- | --- | --- |
| One complete question; optional source disclosure | Preserve meaning and let the user inspect the trigger. The reviewed gaze studies do not validate this reading format. | Implemented in the fictional demo. Compare understanding and distraction with and without prompts. |
| Opening context holds the question; save and dismiss still work while paused | W3C guidance on controlling changing information informs the design. | Implemented and covered by lifecycle and browser tests. Check discoverability and native assistive technology; no conformance claim. |
| Bottom-right default; optional placement near the camera | Gao et al. (2025) and Horstmann and Linke (2022) found setup-dependent gaze effects, with different optimal directions. | Placement is implemented. No TalkQTE study establishes less visible reading or improved eye contact. |
| Larger text and a keyboard route through the notebook | Readability and user control are design requirements; W3C text-spacing guidance informs adaptable layout. | Implemented with narrow-layout checks. Native VoiceOver and cross-app behavior still need verification. |
| No gaze score or pressure to sustain eye contact | Ho et al. (2015) describe gaze changes around conversational turns; Garvey et al. (2024/2025) describe varied autistic adults' experiences. | Product constraint. These studies do not establish an accessibility benefit for TalkQTE. |

Primary-source links, study designs, sample limitations, and the proposed comparison are in [Glance view: design and evidence](glance-mode.md). Keep those qualifications with any claim drawn from a study.

## New research intake

The shared [broader research report](https://www.perplexity.ai/search/96f96101-bdaf-442d-b978-c5230df4e616) is pending review: its contents were not accessible on 8 November 2026. No findings or recommendations above are attributed to that report. Add its summary and verified primary sources when the text is available.

For each finding we adopt, record the source and date, population and task studied, relevant result and limitations, the proposed product decision, and a way to check it in TalkQTE. Label the decision as implemented, proposed, or deferred. Distinguish a published result from our inference and from a measured TalkQTE outcome. Preserve contrary findings that could change the decision.

Use the [reusable research prompt](research-prompt.md) for later updates. A search result or research synthesis is a starting point for checking the underlying sources, not proof that the app works.

## Reuse on the website

Keep the detailed evidence and decisions in this app repository. The [website repository](https://github.com/connorburgess/talkqte-web) can use a short explanation and link here, so a second research document does not drift from the implementation.

Suggested coming-soon wording:

> One useful question, at the right moment. TalkQTE is an early desktop prototype exploring timely clarification prompts, with saved questions and optional notes. Follow its development on GitHub.

A later design explainer can say that Glance view presents one complete question, offers its source on request, and lets users choose larger text or optional near-camera placement. Describe these as prototype controls, with a link to their [evidence and limits](glance-mode.md).

Do not turn related studies into claims that TalkQTE hides reading, improves eye contact, reduces cognitive load, treats a condition, or has proven accessibility or meeting benefits. Those outcomes have not been established. Local live transcription and provider integrations are still development targets, not available features.
