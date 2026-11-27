# Interview mode

Choose **Session type → Interview** in the Notebook before starting a live session. It works with the standard own-key cue providers for human or AI-led interviews. Session type cannot change during capture or while stopping. It carries into the next prepared session until you quit; a fresh app launch defaults to Meeting. Development CLI and lab routes do not support changing session type.

Prepare one real example: the situation, your contribution, a trade-off and the result. The cue policy asks for a brief nudge only when the supplied conversation clearly supports an unanswered part of an explicit request and the response is wrapping up or moving away. An unfinished answer or newly asked question alone should stay quiet. This is a model instruction, not a guarantee of semantic accuracy or useful timing.

A useful nudge recalls a specific relevant detail already supplied, rather than repeating the question. For example, if the supplied conversation states that a queue added two engineer-days of monthly maintenance, that detail can help with an omitted trade-off after the response clearly concludes. This is an illustrative scenario, not a guarantee of live behavior. If the detail is absent or cannot be connected without guessing identity, the policy asks for silence. The policy forbids inventing experience, metrics, achievements or prepared stories, scoring the interview, guessing emotions or hiring likelihood, and suggesting concealment of assistance. The same guidance applies to human and AI interviewers.

## Sources and controls

The provider request adds `sessionMode: "interview"`. Meeting mode omits the field. Existing speech scope, destination, permission, source validation, freshness, occupied-cue, Asked you, repetition and copied-question checks still apply. Selecting Interview starts no capture and adds or shares no past meetings, notes or files. Earlier material is available only through an independently supported, explicitly approved context route; the ordinary live request does not gain prior notes from this mode.

Default provider speech labels remain anonymous `Speaker`. The model cannot reliably identify which person is the candidate, determine who finished answering, or infer that unheard context does not exist. The policy asks it to stay quiet when that ambiguity matters. There is no answer-completion detector or interview scoring system. **Pause cues** and **Stop live session** retain their normal behavior.

## Acceptance and remaining blocker

Offline command, lifecycle, serialization and browser checks cover mode selection and boundaries. Authored examples and synthetic previews are not evidence that a live model follows the policy. The next readiness blocker is useful timing with ambiguous speakers. A bounded, separately approved fictional interview evaluation should measure interruptions during developing answers, unsupported nudges, repeated questions, and helpful recovery of explicit unanswered requests across human-led and AI-led scenarios. Do not describe this mode as validated interview coaching until that evidence exists.
