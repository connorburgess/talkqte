# Owned development launcher

This internal follow-up supplies the synchronous launcher and private timing-file
adapter used by the [run lifecycle](lab-run-lifecycle.md). It launches nothing at
import or preparation. There is no command-line entry point, shell, arbitrary
argument list, existing-PID attachment or provider fallback. The actual app run
still requires an approved build and separately reviewed bounded launch plan.

## Build approval before launch

`prepareLabLauncher` requires a private absolute `manifestFile` outside the
checkout and a separately supplied approval tuple: `manifestSha256`,
`executableSha256`, and `commit`. The tuple must come from the native/coordinator
review of the concrete build receipt. Never construct approval from the manifest
being checked. No approved backend/Stop artifact is currently supplied; the older
capture-only build is ineligible.

The exact `talkqte.lab.build.v1` record contains `schema`, `executable`,
`bundlePath`, `sha256`, `commit`, `features`, `debug:true` and `signature`.
`signature` contains only `identifier`, `authority` and `designatedRequirement`.
Unknown/missing fields, duplicate JSON keys, duplicate/extra/missing features,
unapproved digest/commit, noncanonical paths and nonprivate records are refused.
The approved features are exactly `lab-evaluator`, `local-whisper`,
`native-audio-spike` and `timing-log`.

The executable must be the canonical regular `Contents/MacOS/talkqte` inside the
canonical `.app`. Info.plist must name that executable and
`com.talkqte.desktop`. Preparation performs strict deep codesign verification and
compares the signature identifier, sole `TalkQTE Development` authority and exact
reviewed designated requirement including the pinned leaf certificate. No ad-hoc
or name-only fallback exists. The approved SHA256 binds the signed executable to
the reviewed source/features receipt; a valid signature alone cannot establish
those feature/commit claims.

Immediately before the direct owned spawn, executable hash, file identity, size,
mode and timestamps must still match preparation. A changed artifact is refused.
This is not an atomic verify-and-exec primitive or protection against an adversary
changing files after the final check. Runtime session metadata cross-checks the
reviewed commit and all four features when observed; it never supplies prelaunch
approval or proves that a missing log event was delivered.

## Explicit scope and environment

Supply the pinned provider/model/effort/attempt cap as `selection`, the explicit
`sourceApplication:"QuickTime Player"`, positive finite integer `stopAfterS`,
`modelConnection:"on"` and canonical existing external `whisperModel`. The source
is restricted to the approved fictional QuickTime-only topology. This selects
all QuickTime windows/audio, not one document; the run plan must establish that
only the intended fictional document is active. Native must enforce its pristine
microphone/source-only admission rules before arming. No microphone or alternative
source is selected by this launcher.

The launch settings must match lifecycle metadata and its exact broker descriptor.
The environment retains only HOME/PATH/TMPDIR/LANG/LC_ALL plus the frozen approved
lab/source/model/Stop settings. Ambient API keys, endpoint/proxy/provider overrides
and runtime injection settings are refused. The ordinary timed Stop guard is
independent of USR2; neither its expiry nor process termination proves release.
The descriptor's owned regular file is validated and its canonical path forwarded,
including macOS `/var` aliases. No nonce or credential is read or copied.

The prepared object's `launch` is passed to `createLabNativeOwner`; it returns
only its directly spawned child handle. Listeners and timing observation are
installed before spawn. Arming's five-second clock begins when that owned handle
exists, not during prelaunch verification. The owner waits for exact-run `armed`,
sends USR2 once and requires `latched` → `stopping` → `released` or failure.
Six seconds after signaling and twelve seconds total remain the cleanup bounds.

## Bounded observation, not a disk quota

Each launch gets a unique external `0700` directory and owned `0600` regular
file. The reader pins its file identity and fails on rotation, observed truncation,
permission changes, malformed UTF-8/JSON, duplicate keys, wrong run/source,
oversize or incomplete frames. Default bounds are 8 MiB observed file size,
64 KiB per frame/read batch, a 20 ms polling interval and one-second partial-frame
deadline. Parsing and buffers are bounded; transcript/model text is discarded from
callbacks. Events forwarded to lifecycle are content-free.

**The native append writer has no hard stored-byte cap.** Polling and ordinary
cleanup can overshoot the file observation limit; a transient change between
polls is not guaranteed detectable. Oversize/invalid evidence stops the shared
run and cannot admit a later operation. No quota, filesystem setting, shell
wrapper or forced kill is used to claim release.

The channel remains lossy and unacknowledged. Missing armed means no USR2;
missing released means unconfirmed cleanup, even with source/process-end events.
The reader drains bounded final evidence before the owned child's exit listener;
a partial or unreadable ending fails closed. Observer close does not terminate
an app or prove native release. Evidence stays private outside the checkout;
actual app retirement and retained-artifact cleanup must be explicit in the run
plan, never disguised as release proof.

## Offline evidence and remaining acceptance

```sh
node --test scripts/cue-lab-launcher.test.mjs
```

Tests spawn only the committed harmless Node fixture copied into its private
runtime directory. The explicit fixture route fixes the Node executable and
program; it accepts no caller-supplied command or arguments. It uses no app,
audio/video device, model, network or credentials. POSIX signal/file-permission
checks are skipped on Windows.

Actual-child checks cover readiness/exit, partial lines, rotation/truncation,
file/frame overflow, malformed/duplicate input, wrong run, lost events, changed
preverified files and shared-run cancellation before authentication. Build-record
checks are offline schema/approval checks; they do not establish a real code
signature or app's behavior.

The next step is review of this adapter and matching native Stop/activation,
then native/coordinator supply of the approved signed build receipt and an exact
launch plan. Supported exact-file QuickTime controls, visible companion/model
readiness and real streamed speech → cue/silence → paint acceptance remain
unverified. No model/app/player run is authorized by these tests.
