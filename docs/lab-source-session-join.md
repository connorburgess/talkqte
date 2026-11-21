# Identity-bound lab source session

This development-only follow-up joins the native v1 source observation to the
broker's authenticated session. It does not launch an app or provide a player.
The existing historical Listening adapter remains a separate offline fixture
path; it is not promoted to identity-bound evidence.

## Startup and ownership

Construct `createLabSourceV1({launcher, commit, features})` before launch. The
observer requires the exact owned process identity, armed run, checked live
session metadata, application acknowledgement and one valid
`dev_source_observation` listening tuple. The tuple retains run, application,
host operation, live operation and source session. Duplicate, missing, malformed,
retired, replaced, ended, closed or failed evidence terminates observation.
Retirement is not native source release.

The prepared driver subscribes to terminal source notifications before starting
the run. This subscription remains active after `waitListening` resolves; a late
retirement aborts the root ownership path, including playback, provider and
recorder cleanup. An already-resolved readiness promise cannot supply this
notification by itself.

For a v1 source, the driver calls `run.expectSourceSession(sessionId)` exactly
once before recorder startup and playback. The expected session cannot be rebound,
including to the same value. The broker defaults to requiring this expectation
before authenticated hello; hello must match it exactly. Calibration validates
that authenticated identity independently and returns its `sessionId`. Neither
receipt timestamps nor clock estimates establish identity equality.

The bootstrap order remains source observation, session expectation, recorder
frame acceptance, actual player-start acknowledgement, speech-triggered native
hello, calibration and run readiness. Waiting for hello before playing speech
would deadlock the lazy native connection. No model dispatch is admitted before
both actual playback acknowledgement and calibration.

## Session representation

V1 source and broker sessions are canonical positive decimal u64 strings. The
native timing session metadata is a JSON number. In strict mode the timing parser
preserves its original JSON token through the JSON parser's reviver source
context, validates canonical decimal spelling and range, and forwards a string.
It never converts a rounded JavaScript number to a session string. Duplicate
keys, exponents, zero, leading zeroes and overflow are rejected. Full-range u64
values therefore compare without precision loss. A parser runtime without source
context fails closed.

Production launchers select v1 timing observation. Harmless fixture launchers
retain explicit `legacy-fixture` observation. The lifecycle permits
`sourceSessionMode: 'legacy-fixture'` only with explicit offline stand-in
execution; a real prepared source must expose `mode: 'v1'` and terminal
subscriptions. Legacy fixtures do not establish native acceptance.

## Evidence and remaining acceptance

Deterministic tests exercise the real broker socket, lifecycle and prepared
driver with injected provider, source and playback stand-ins. They cover exact
session matching, full-range lexical preservation, mismatched hello and clock
samples, startup ordering, replacement and retirement after readiness, and
once-only cleanup. These are not native, model, audio or recording acceptance.

Native v1 observations describe the identity checked at a guarded point in time.
Timing delivery remains lossy and can lag retirement or Stop. The JS join does
not make it atomic or prove current audio, physical audibility, visible cue paint
or successful release. Missing evidence fails without retry or heuristic repair.

The first saved-media take still requires a reviewed signed native build and
source identity, strict recorder helper and exact window discovery, a genuine
render-clock player start and completed-audio acknowledgement, and a separately
bounded integrated execution plan. QuickTime's inspected scripting interface
exposes movie time and playing state but no render-clock/drain acknowledgement;
those properties cannot substitute for the player contract. Adaptive synthesis
and incremental playback remain a later milestone.
