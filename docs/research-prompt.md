# Deep research prompt for TalkQTE

Copy the prompt below into a research tool with live web access. Replace the repository snapshot with the version you want evaluated, or ask the researcher to inspect the public default branch. Do not provide private meeting recordings or transcripts.

---

Research the latest scientific findings, interaction patterns, and technical approaches that could meaningfully improve **TalkQTE**, as of today's date. Search broadly, then prioritize sharply. I want useful participation and a small, dependable product, not a list of fashionable features.

## Product context

TalkQTE is an early macOS meeting companion built with Rust, Tauri, and React. Its central idea is **one useful clarification question, at the right moment**: help a participant notice an unresolved owner, vague deadline, unclear decision, or important unanswered question while the conversation is still on that topic.

It should complement existing note-taking tools, with Granola the first integration preference and Fireflies second. Their app can remain the main meeting record. A small notebook and saved questions are sufficient; meeting archives, CRM, long generated answers, and automatic speaking are not the core product.

The researched baseline has a fictional-meeting demo, a floating question window, and an explicitly enabled microphone activity monitor. Activity is not speech recognition, speaker identification, or evidence that the user is speaking. Live transcription, persistent storage, and provider integrations must not be assumed implemented. A Glance view is being explored: a short complete question, supporting context on demand, stable reading time, adjustable text, and optional near-camera placement. This does not modify video.

Inspect https://github.com/connorburgess/talkqte before making implementation claims. Record the commit and date reviewed. Distinguish merged code, open PRs, documentation, and proposals. If repository access fails, state that and use the baseline above as provisional context.

## Research questions

1. **Participation and cognitive load.** What helps someone listen, formulate a question, remember context, and participate while another person speaks? Study divided attention, working memory, interruptions, cognitive offloading, confidence, anxiety, and conversational turn-taking. When does assistance make participation worse?
2. **Prompt content and timing.** Compare complete questions, keywords, evidence snippets, progressive disclosure, and cue modalities. Research when to wait, surface, cancel, expire, or hold a prompt. How should the system handle transcript revisions, already-resolved ambiguity, direct questions to the user, uncertainty, and silence? Avoid arbitrary universal word counts or timing thresholds.
3. **Accessibility and individual control.** Examine varied vision, reading, hearing, motor, speech, language, attention, and sensory preferences, including neurodivergent users without assuming uniform needs. Consider keyboard and screen-reader access, reflow, text spacing, reduced motion, adjustable reading time, camera-off use, and simple personalization without diagnosis or inferred disability.
4. **Gaze and presentation.** Separate reading movements, camera/screen offset, natural gaze aversion, near-camera layouts, optical prompters, and actual video eye redirection. Examine comprehension, comfort, perceived naturalness, and artifacts. Do not equate eye contact with attention, competence, honesty, or engagement. Distinguish live Mac solutions from Windows-only and post-production tools.
5. **Trust and user agency.** Research automation bias, overreliance, uncertainty communication, provenance, false positives, dismissal, and recovery. How can the user understand why a question appeared without adding more reading? Which proposed explanations are supported by actual source text?
6. **Local speech and contextual understanding.** Assess streaming ASR, latency, partial-transcript stability, noise, overlapping speech, accents, multilingual use, speaker attribution, addressee detection, and lightweight clarification methods on realistic Macs. Compare rules, small models, and hybrid approaches. Separate benchmark results from measured end-to-end performance in a live call.
7. **Privacy and practical compatibility.** Investigate on-device processing, bounded retention, explicit capture, local/cloud boundaries, and supported meeting-app or note-taker interfaces. Distinguish prior-note import, live transcript input, and export/writeback. Verify current API availability, access restrictions, and platform constraints. Treat screen-share exclusion as a compatibility question to test, not a guarantee.
8. **Adjacent approaches and evaluation.** Look at augmentative communication, just-in-time assistance, cueing, conversational coaching, teleprompters, human-computer collaboration, and notification research where transfer is plausible. Identify existing products or open implementations worth testing, clearly separated from scientific evidence. Propose evaluations that measure participation and listening rather than clicks or suggestion volume alone.

## Evidence standards

- State the search date and search terms. Prioritize the last 24 months while retaining older foundational studies when they are more informative. Distinguish first publication, revision, and access dates.
- Prioritize original studies, technical papers, and official platform documentation. Use systematic reviews to orient the literature and trace important claims to their underlying evidence. Label preprints, qualitative findings, vendor claims, and personal anecdotes separately.
- Link directly to every important source using its DOI, publisher, official documentation, or original repository. Verify title, authors, year, sample, task, and what was actually measured. Do not invent citations or present an abstract-only read as full-text review.
- Report contradictory findings, null results, small or unrepresentative samples, accessibility tradeoffs, and limits to transferring laboratory tasks into real meetings. Lack of evidence is not evidence of no benefit.
- Separate **finding → applicability to TalkQTE → proposed design → validation needed**. Do not turn an inference into a measured outcome or promise a clinical, privacy, performance, or accessibility benefit.
- Do not infer emotions, disability, attention, honesty, or competence from gaze, facial expression, voice, or microphone activity. Research user-controlled alternatives.

## Deliverables

1. An executive recommendation: the five most promising improvements, the three things to avoid, and what would change your judgment.
2. An evidence table with source/date, evidence type, population and task, finding, limitations, relevance to TalkQTE, confidence, and proposed next action. Separate empirical confidence from confidence in product fit.
3. A prioritized backlog: **improve the current prototype**, **validate before building**, and **defer**. For each item describe user benefit, concrete behavior, default versus opt-in choice, dependencies, implementation uncertainty, and an experiment that could disprove its value. Do not invent precise effort estimates.
4. Concrete interaction examples using fictional meeting content, including a useful cue, a resolved issue that should stay quiet, ambiguous attribution, a held question, and an accessibility preference that changes presentation.
5. A small formative test plan that separates cue content, timing, placement, and automated detection quality. Include a no-assistance baseline, counterbalanced conditions, listening and comprehension measures, useful clarification, interruption burden, comfort, and assistive access. Explain what a small sample cannot establish. Recording requires separate consent and is optional when unnecessary.
6. A short feasibility assessment for macOS, listing verified capabilities, untested compatibility, and unknowns. Keep camera effects, transcription, and UI presentation separate.
7. A concise reading list and a repeatable search plan for future updates. End with the highest-value next step for this particular app, not a proposal to build an entire meeting platform.
