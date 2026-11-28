# Investigating a session with no cues

An empty saved cue list does not establish that the model chose quiet. It can
also mean no evaluated processing was enabled, permission was absent or revoked,
a request failed, or a proposed cue did not pass the timing/source/display gates.
Saved meetings do not retain evaluation outcome counts.

Before restarting or starting another session, open **Settings → Privacy &
setup → Diagnostics → Show diagnostics**. Review the report before copying it.
It contains selected settings, key status and fixed codes, not meeting text or
credentials. Showing this report does not test a key or call a model.

Useful fields include Cue processor, Cue processing, Cue processing approved,
Cue processing stopped, Cues paused, Sensitivity, Companion shown, Cue requests
and estimated cue spend. A stopped issue is different from a quiet decision.
The live processing panel may show the latest quiet decision; it does not
provide a session-wide history of those decisions.

The native usage counter is process-local and survives Stop until another
connection replaces it or the process exits. It has no session identifier.
Diagnostics therefore omits requests and spend for a session without a matching
own-key processor, for another provider, or for a simulated or lab session.
A dash means unavailable, not zero. Matching the provider is a display guard,
not proof of session identity. Collect the report while the relevant live/ended
session is still retained; do not attribute an old report to a reopened meeting.
A positive request count records attempts to send to the provider, not successful
decisions, shown cues, exact billing, or usefulness. No request count distinguishes
quiet, failures and display gates on its own.

## Source paths and scope

In the standard own-key path, Start registers the selected keyed provider and
approves new speech with no prior notes. Missing provider keys leave phrase rules
available. Capture, cue pause, processing permission, provider failures and the
companion visibility setting remain separate controls. The own-key model input
contains bounded recent speech and the selected session mode; imported notes
are excluded. Importing or selecting a note does not put it into this route.

The development `selected-prior-v2` route is separate and requires its own
explicit selection/review. On the historical `c993d2c` source, its native selected
serializer omits interview mode. The ordinary own-key serializer includes it.
That mismatch affects which policy instructions the lab request can use; it does
not establish why an ordinary session produced no cues. Check exact installed
source and actual route before drawing conclusions. See [Interview mode](interview-mode.md)
and [own-key cue scope](own-key-cues.md).

## Existing development timing logs

Timing logs require a build containing `timing-log` and an explicitly configured
`TALKQTE_TIMING_LOG` path at launch. They cannot reconstruct a past unlogged run.
They are intended for fictional development sessions: raw logs also contain
transcript segments and some phrase-cue text. Do not enable them for real
conversations or share their raw contents as support diagnostics.

For an already authorized existing log, a local reviewer can aggregate only
closed event codes/counts without returning raw lines. Relevant events are
`evaluator`, `evaluation_requested`, `evaluation_result`, `evaluation_stopped`,
`cue_dropped`, `cue_decision` and `cue_published`. Preserve `dropped` counts and
malformed/incomplete-log limits. A returned `show` precedes source freshness,
slot, cooldown, focus, repetition and copied-question checks; `cue_dropped`
records those rejections. A `cue_decision` shows engine acceptance and
`cue_published` a companion snapshot, not proof that a window painted or a person
read it. Never include free-text fields in an aggregate report.

## Remaining acceptance

Session-bound cumulative evaluation/quiet/failure/drop counters are not yet
retained with kept meetings. A future bounded diagnostic summary needs fictional
coverage for quiet, invalid replies, transport failures, gated proposals, Stop,
replacement sessions and redaction. The current report guard does not add those
counters or establish live model quality. Investigate the actual route and safe
counts before changing policy, scope, settings or provider behavior.
