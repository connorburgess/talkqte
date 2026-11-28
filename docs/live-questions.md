# Ask about a meeting

Open **Ask** during or after the current live session, or open one saved meeting in **Meetings**. Opening either surface sends nothing. **Send** authorizes the question, the disclosed whole available transcript and bounded prior conversation to the selected provider with your own key. This permission is separate from automatic cues. There is no repeated review modal, automatic retry or cross-meeting search.

Questions accept 1–1,000 Unicode scalar values (an astral character counts once), with at least one non-whitespace character. Tabs and newlines are allowed; carriage returns, NUL and other control characters are rejected before a request begins. Byte/cost preflight reserves seven nested-JSON bytes per question character, a conservative bound even for controls that validation rejects, inside each actual provider envelope. The actual serialized request is checked again before credential access or transport.

The inline disclosure names the provider/model, transcript line count and number of prior exchanges. **Transcript scope and cost** shows the frozen time range, omissions and conservative maximum estimate. **Use latest transcript** refreshes without sending. New speech does not silently extend an already prepared request. “Whole” means all lines in that available snapshot, not a guarantee that capture or transcription was complete or correct.

## Whole transcript or no request

The complete serialized provider request must fit **128 KiB**, including transcript IDs/timestamps/text, prior conversation, an escaped maximum-length question, instructions, schema and provider envelope. The reservation uses one input token per serialized byte plus the shared safety margin and the full output allowance. It must also fit the lower applicable cost limit. No tail, sampling, automatic chunking, summary substitute or larger-model fallback is used. An over-limit transcript, or an in-memory session whose beginning has been discarded, is refused with an explanation and a path to review/export its transcript. Ask cannot provide a misleading overall assessment from a silently shortened tail.

Speaker names/roles, imported context, saved notes, cues and other meetings are excluded. Only transcript line IDs are valid citations. A citation establishes that a line was supplied, not that a model's claim is true. Answers are labeled model output, rendered as plain text and can be wrong. A substantive answer requires one to six distinct supplied citations; an insufficient-evidence answer has none. The answer limit is 2,400 characters and the provider output limit remains 1,200 tokens, including any provider-accounted reasoning.

## Follow-ups and retention

Up to the latest **three accepted Q&A pairs**, within **12 KiB** serialized as whole pairs, may be included to interpret follow-ups such as “Why that choice?” Whole oldest pairs are omitted, with their count disclosed. Failed, cancelled or stale answers never enter that conversation. Prior model answers are untrusted conversational context, never independent evidence. Their invented facts or line IDs cannot become valid transcript citations. This structural boundary does not prove that a model will reason correctly.

The latest ten accepted entries stay in memory. **Clear conversation** removes them without resetting budgets. Navigation closes the current ticket/conversation; switching saved ID/revision clears old chat and citations. A saved citation belongs only to its exact saved meeting and revision: positional IDs are not globally stable, and old citations are never remapped into an edited transcript. Q&A is not added to transcripts, saved meetings, generated notes or exports. Quitting loses it.

## Budgets and cancellation

Rust owns the snapshot, source identity, tickets, one physical Ask worker, 30-second deadline and two-second request interval. Unknown/unpriced models are refused. Each question reserves a conservative maximum of **$0.25**, within **20 sends and $1 cumulative reservations**. Failures and cancellations retain their reservations. These are built-in-price estimates, not billing guarantees, and are separate from cue/notes budgets.

The current-session ledger resets only on a true new engine session. The saved-meeting ledger is shared across **all saved meetings for the app process lifetime**; navigation, edits, remounting Ask, clearing chat and starting a live session cannot reset it. Restarting the app begins a new saved-meeting budget lifetime.

**Cancel answer**, navigation, source/revision changes and replacement invalidate pending results. Stop/processing Off retire a current-session request; a later explicit Send is a new authorization. Cue Pause remains independent. A saved snapshot is checked under the history mutation lock before dispatch and before accepting an answer or auth-rejection side effect; transport runs outside that lock. A request already sent cannot be recalled and may be billed. Its physical worker slot stays occupied until it returns. Questions remain editable after an error; sending again is always explicit.

## Evidence and remaining acceptance

Fictional Rust regressions cover full 236-line scope, overflow without fallback, byte/cost accounting across the three provider serializers, source replacement, saved edits/deletion, chat omission, invented-answer citations and late auth retirement. Scripted React fixtures cover current/ended/saved scope, follow-ups, cancellation, grouped citation navigation, narrow rendering and failure states. Authored answers and fake transports establish boundaries, not live model quality or actual native capture.

Next acceptance: separately authorized fictional provider questions with an early transcript fact, follow-up correction and insufficient evidence; measure cost, latency and grounded synthesis. Native keyboard/VoiceOver, dock-to-notebook focus, cancellation and saved-file race acceptance remain open. No real meeting data or provider calls are needed for the automated checks.
