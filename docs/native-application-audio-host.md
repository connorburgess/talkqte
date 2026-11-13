# Development-only application-audio host

13 November 2026. With the `native-audio-spike` Cargo feature on macOS, the app
now has one path that can select an application and start the
[source worker](native-audio-owner.md#source-worker-and-transcript-sink--13-november-2026).
It is not in a default build, has no interface in the notebook, and was not run:
no application was listed, no permission prompt was shown and no stream was
created for this change. Roadmap item **T2** stays open.

## What a development build adds

- `application_audio_host.rs`: the host, its status and the app wiring.
- `application_audio::native::shareable_applications`: one ScreenCaptureKit
  call that lists selectable applications.
- One command, `application_audio`, allowed for the main window only, and one
  event, `application-audio:changed`. The build script lists the command, and
  the app adds its permission at startup, only when the feature is enabled on
  macOS. A default build has neither the command nor the permission.
- The shared capture state in the processing status now includes this source.

## The explicit steps

The command takes one action at a time and returns the current status.

1. `list`, with `acknowledged: true`. The interface must have shown the scope
   notice first: "Audio from all windows of this application may be included."
   Without the acknowledgement nothing is asked of the OS. With it, the worker
   asks ScreenCaptureKit for shareable content once. **macOS can show its
   Screen Recording prompt at this step**, before any application has been
   chosen; the system picker the plan mentions is not used. `cancelList` stops
   waiting; a late answer is released unused. A listing that is cancelled, or
   overtaken by quitting, before the worker takes it is never put to the OS.
2. `review`, naming one listed application. Nothing is requested of the OS. A
   later review replaces this one, and the earlier approval is worthless.
3. `start`, naming that review. Only the application under review can start.
   The worker loads a second local recognizer, checks that the live session is
   still the one that was running when it began loading, accepts the session
   clock, which attaches the source to that session, and only then begins the
   native stream for that one application. A start stopped while it waited
   loads nothing.
4. `stop`, naming the review or operation. A request for another operation is
   refused as changed. The live session's own Stop also ends the source.
5. `retryCleanup`, naming the operation, after the status has shown a failed
   cleanup. Otherwise it is refused as nothing to retry.

A start needs a running live session with no other application source. If
there is none, or the build has no local transcription, the start ends before
any native request and the status says why.

## The status

The status says **Off only when nothing was started or native cleanup was
confirmed**. Everything else is one of:

| Phase           | Meaning                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `listing`       | Waiting for the OS to list applications. Nothing is captured.                                                        |
| `reviewing`     | One application is under review. Nothing is captured.                                                                |
| `starting`      | Approved; the native start has not been confirmed.                                                                   |
| `listening`     | The OS confirmed the start and Stop has not been requested.                                                          |
| `stopping`      | Stop was requested, by this host, the live session or the worker, and native cleanup has not been confirmed.         |
| `cleanupFailed` | The OS reported that Stop or output removal failed. The application may still be captured until a retry succeeds.    |
| `abandoned`     | The worker ended without confirming cleanup. The application may still be captured until TalkQTE quits.              |

`mayBeCapturing` is true for the last five. `stalled` becomes true when one
unbroken spell of `stopping`, counted from the first status read that saw it,
has lasted five seconds. That number is host wording policy, not a measured
release time, and nothing is forced, retried or reported Off when it passes. `canRetry` is true only in `cleanupFailed`. The status also carries the
application name, an opaque operation identifier, the listed choices, a
problem label and the scope notice. After a released operation it also carries
that run's counts: chunks recognized, lines accepted and refused, lines timed
outside their audio, chunks withheld or refused, recognizer failures, whether
the transcription worker had to be detached, and the width of the accepted
clock read. It carries no audio, transcript or native identifier.

The event is published by a 200 ms refresh, so `application-audio:changed`
can trail the state by up to that long. The command's own reply is current.

A failed cleanup is retried only on request, one request at a time, and a
second request needs a newly reported failure. An unanswered Stop is not a
failure the OS reported, so it offers no retry. An abandoned operation accepts
no retry and blocks any new selection until the app is restarted, because
nothing in the process can still stop that stream.

The processing status's capture state is combined with this phase: it never
reads Off or Unknown while `mayBeCapturing` is true. With the microphone off, a
failed, unanswered or abandoned cleanup reads `stopping` there. A microphone
that is starting keeps reading `starting` whatever the source is doing: the
notebook disables its Stop control while capture reads `stopping`, and a stuck
source must not take Stop away from a starting microphone. That path runs
with the runtime lock held, so it reads the phase from an atomic the host
writes under its own lock, at approval and on every status read. It can lag a
release by one refresh, never a start, and the host lock is never taken under
the runtime lock.

**The notebook's wording is wrong for this case.** It renders that shared
state as microphone text, so in a development build a failed or abandoned
application cleanup with the microphone off would show a message about waiting
for the microphone, and nothing in the notebook shows this host's own status.
The interface is outside this change; do not judge a device run by the
notebook until it shows the application-audio status.

One control is still affected. The notebook offers **Cancel start** only while
capture reads Off. If an earlier application source is stuck in `stopping`,
`cleanupFailed` or `abandoned` and the microphone has not begun starting, the
shared state reads `stopping`, so a new live session's model loading shows a
disabled Stop instead of Cancel start until the microphone itself starts. The
fix is for the source to have its own field in the processing snapshot instead
of sharing the microphone's; that is the next step, with the interface.

## Quitting

On an exit request the host refuses new work and requests Stop, without
waiting. It does not hold the app open for cleanup. Whether macOS ends an
unconfirmed capture when the process exits has not been checked.

## Tests

Fifteen tests cover the host. Twelve run it against the real source-worker
ordering, with a fictional clock read, a memory-only clock feed, a scripted
owner and a real `Mutex<Runtime>`; one checks the decisions made before the
native request; two are table checks:

- Listing is refused without the acknowledgement and the backend is never
  asked. Review is explicit, a replaced or cancelled review cannot start, and
  only the reviewed application starts.
- Stop, whether asked of the host or of the live session, reads `stopping`
  at once and Off only after release; a Stop for another operation is ignored.
- A failed Stop reads `cleanupFailed` across further polls with no automatic
  retry and no new selection. One retry is accepted, a second is refused, and
  the retry releases it.
- When the retried Stop fails again, that newly reported failure allows one
  more retry. When the retried Stop is never answered, no further retry is
  accepted, however long it stays unanswered.
- A listing cancelled, or overtaken by an exit request, while the worker is
  still busy is answered as cancelled and the backend is not asked again.
- Before the native request, in order: a stopped start loads no recognizer; a
  source that is not one of the listed selections is refused; no live session
  is refused; a recognizer that cannot load is refused; and a live session
  replaced while the recognizer loads is refused. This runs the same function
  the app uses, with a shared runtime in place of the app's.
- A Stop completion that never arrives reads `stopping`, then `stalled`, an
  hour later still not Off, with no retry offered, also after an exit request.
- A worker that faults reads `abandoned`, refuses retry and new work, and has
  closed delivery to the session.
- Stop and exit while the native start is unanswered read `stopping`. When the
  start then succeeds late it is stopped and never accepted as capture.
- A start with no live session, or a session that already has a source, ends
  Off with its reason and sends no native request.
- Stop while the run request is still waiting ends Off with no problem, loads
  nothing and leaves the live session alone. From approval on, the lock-free
  phase reads as possibly capturing before any status read.
- When no worker thread can be started, or the worker faults while listing,
  listing is refused or reads as failed, the status is Off because nothing was
  started, and the host still answers. An earlier revision locked itself up
  here, which would have stalled the runtime too.
- An unanswered listing can be cancelled and its late answer is unused; a
  refused listing says permission was denied.
- Two table checks: every native stage maps to a phase that does not
  understate capture, and the shared capture state is never Off or Unknown
  while the source may be capturing.

Mutation checks, each restored afterwards and each failing at least one test:
reading a failed cleanup as stopping, treating an unwound worker as finished,
reading a cancelled start as starting, ignoring the source in the shared
capture state, blaming the session for a start the person stopped, not marking
the phase at approval, keeping a listing request alive under the host lock,
showing a starting microphone as stopping, and putting a cancelled listing to
the OS. The host tests passed 30 consecutive runs.

The scripted owner stands in for ScreenCaptureKit's completions and is a
second, simpler copy of the owner's stage logic, not the real owner with a fake
driver. These tests establish what the host reports for a given sequence of
native answers, not that the OS gives those answers; the real owner's handling
of a late start has its own tests in the owner module.

Not exercised: a failed output removal and its retry, a failed or faulted
stream as the reported outcome, a second complete operation after the first,
exit while listing or reviewing, a fault in the worker outside its loop, and
everything in the app wiring.

## Not run, and the gates that stay open

The app wiring was compiled with the feature and never executed: the command,
its permission added at startup, the status event, the exit hook and the real
enumeration. The second recognizer's loading code exists only when
`local-whisper` is enabled as well, which is the one configuration that can
actually start a source. That pair was compiled and linted locally for this
change; CI compiles `native-audio-spike` alone, where a start is refused for
lack of local transcription. Treat all of it as unverified until a development
build is run on a device.

Against the [selected-application acceptance gates](system-audio-plan.md):

- **The plan's first step cannot be done through this host.** The plan tests
  one fictional source alone before combining it with the microphone. A start
  here needs a running live session, which today begins with the microphone
  and local recognition. A source-only run needs either a session that can
  start without the microphone or a separate harness; that is undecided.
- **Consent and UI/UX: open.** There is no rendered flow. The acknowledgement
  is a flag the future interface sets on each request; Rust refuses to list
  without it but cannot know that the notice was shown. Truthful naming on
  macOS 14.0, keyboard selection, Cancel and Stop without losing focus, and
  denial recovery need a device and an interface. Whether a refused prompt
  answers at once, and whether granting needs a relaunch, is unknown.
- **Privacy and scope: open.** The selected marker being included, an
  unrelated marker excluded, zero delivered video buffers, nothing in
  webviews, files, temporary storage, logs or the network, and no global
  capture all need the fictional two-application experiment. The list
  includes every application ScreenCaptureKit reports, TalkQTE itself among
  them, and all of those names are sent to the main window. The filter uses
  the first display reported; an application on another display is untested.
- **Lifecycle: open on a device.** The host's reporting for late start,
  failed Stop, unanswered Stop and a faulted worker is covered above with
  scripted answers. Actual release time, denial, revocation, the selected
  application quitting, device change, and sleep and wake are not.
- **Audio contract: open.** Clock drift, real buffer sizes, callback
  allocation and the delivered channel and sample-rate layout are unmeasured.
  The engine refuses any line timed before the last line it accepted, whoever
  sent it. With a microphone and an application in one session, a line from
  either can therefore be dropped because the other's later line arrived
  first: **attaching a source can drop microphone lines**. Microphone pickup
  of the same speech could also add duplicate lines. Neither is handled, so
  transcript quality must not be judged through this host. The refused-line
  count in the run's record shows how many of the source's lines were lost
  this way, not the microphone's.
- **Performance: open.** A second recognizer is loaded for the source; its
  memory and CPU cost against the budgets is unmeasured.

Also open: handing the listed content object from the framework's queue to the
worker thread (and checking it for leaks), the two clock limits (2 ms read
width, 250 ms snapshot age) and the five-second stalled wording are all
unvalidated choices. A fault before the native start also reads `abandoned`
until restart, because the host cannot tell it from a fault after it.

Running any of this needs the owner's explicit authorization for a bounded
experiment with fictional audio, as the plan requires.
