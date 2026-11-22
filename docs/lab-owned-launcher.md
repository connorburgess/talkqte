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
The approved features are exactly `cloud-transcription`, `lab-evaluator`,
`native-audio-spike` and `timing-log`. Local transcription has been removed
from the app (#346), so a build reporting `local-whisper` is refused.

The executable must be the canonical regular `Contents/MacOS/talkqte` inside the
canonical `.app`. Info.plist must name that executable and
`com.talkqte.desktop`. Preparation performs strict deep codesign verification and
compares the signature identifier, sole `TalkQTE Development` authority and exact
reviewed designated requirement including the pinned leaf certificate. No ad-hoc
or name-only fallback exists. The approved SHA256 binds the signed executable to
the reviewed source/features receipt; a valid signature alone cannot establish
those feature/commit claims.

Immediately before the direct owned spawn, strict/deep bundle signature,
pinned identity/designated requirement and Info.plist metadata are verified
again, and executable hash, file identity, size, mode and timestamps must still
match preparation. A changed artifact is refused.
This is not an atomic verify-and-exec primitive or protection against an adversary
changing files after the final check. Runtime session metadata cross-checks the
reviewed commit and all four features when observed; it never supplies prelaunch
approval or proves that a missing log event was delivered.

## Explicit scope and environment

Supply the pinned provider/model/effort/attempt cap as `selection`, the explicit
`sourceApplication:"QuickTime Player"`, positive finite integer `stopAfterS`,
and the `transcription` described below. A model run uses the direct API
route only: its in-app review approves both the model connection and cloud
transcription. A Codex or Claude CLI model launch is refused before anything
is verified: "This route has no transcription: cloud transcription is approved
only through the in-app review, which the subscription routes do not use." An
API-route model launch without cloud transcription is refused too. There is no
local transcription model, and a `whisperModel` option is refused. The
subscription adapters remain for offline use (the scenario generator uses the
Codex route). The source
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
The outside-checkout boundary is anchored to the canonical module repository
root, independently of the caller's current directory, and resolves symlink
targets. The descriptor's owned regular file is validated and its canonical path forwarded,
including macOS `/var` aliases. No nonce or credential is read or copied.

The prepared object's `launch` is passed to `createLabNativeOwner`; it returns
only its directly spawned child handle. Listeners and timing observation are
installed before spawn. Arming's five-second clock begins when that owned handle
exists, not during prelaunch verification. The owner waits for exact-run `armed`,
sends USR2 once and requires `latched` → `stopping` → `released` or failure.
Six seconds after signaling and twelve seconds total remain the cleanup bounds.

## Cloud transcription token

On the direct API route a run transcribes through Deepgram (#344). Pass `transcription: { backend: 'deepgram', minuteCap, grant }`, where `minuteCap` is 1–60 for the whole launch and `grant` comes from `mintDeepgramGrant` (`scripts/cue-lab-deepgram.mjs`).

- **Minting:** the grant reads `TALKQTE_LAB_DEEPGRAM_KEY` from `~/.config/talkqte-lab/deepgram.env`. That file follows the same owner, mode and location rules as the API key file (`scripts/cue-lab-key-file.mjs`). The grant posts once, through the platform `fetch`, to `https://api.deepgram.com/v1/auth/grant` for a 900 s token. A refused key, unpaid account or rate limit (401, 402, 403, 429), or any other status, stops before launch.
- **Environment refused:** the grant refuses to run if `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS` or `NODE_USE_ENV_PROXY` is set, even empty. It checks this process's own environment as well as any environment passed in, so a filtered copy cannot hide one. The API route does the same.
- **Where the key and token live:** the key is used only for that request, in this process. The token is held in a closure, never returned or logged.
- **At launch:** the launcher creates an empty `0600` placeholder at `TALKQTE_DEV_STT_TOKEN_FILE` in its `0700` run folder, and sets that variable plus `TALKQTE_DEV_STT_BACKEND=deepgram` and `TALKQTE_DEV_STT_MINUTE_CAP`. The app's session-start check (owner, mode, size, no read) accepts the placeholder, but it holds no token.
- **After review:** the take calls `releaseTranscriptionToken()` only after it has accepted the in-app review row, opened the API provider and confirmed there is still time for the media. A take about to stop for lack of time never hands the token over. The launcher also refuses the call until it has seen that review row for `lab-api` and the launched model. The token is written to a sibling file and renamed over the placeholder. After approval the app waits up to 10 s for the token, buffering the audio, then connects and reports `stt_state` `connected` with the query it used.
- **Order check:** a stream that starts before the review row or in another session, starts twice, or connects before the token was released stops the run.
- **Deletion:** by default the token file is deleted as soon as the stream has connected, and otherwise at close, on a failed launch or at process exit. The app checks the file when a session starts, so a lab run is one session per launch.
- **Optional reconnect retention:** only a model-enabled API launch may explicitly set `transcription.reconnect: true`. It keeps the usable short-lived token in the same owner-only run folder until close, a failed launch or process exit, so a replacement stream can read it again. This retains a valid credential on disk for the run. Without that opt-in a reconnect stops the run. The launcher accepts at most two replacements, only after the first connection and in the reviewed session, and requires every replacement to use the first connection's query. A pending replacement may fail and consume the second attempt before any replacement reports `Connected`. Recovery before the first confirmed connection is refused because no initial query has been confirmed; that narrower launcher workflow remains a native integration limitation. It reports `tokenKeptUntilStop` and the reconnect count; those receipts do not prove native reconnect, device or provider acceptance. The runner SIGKILL limitation below still applies.
- **What deletion cannot cover:** a SIGKILL of the runner skips every cleanup path. A released token then stays in the run folder until the temporary directory is cleaned, and stays valid for up to 900 s. The app is not killed with the runner either. `removeStaleTranscriptionTokens()` removes such files from this user's owner-only `tq-owned-*` folders, but only where the run has provably ended. A folder qualifies if the runner pid it recorded in `runner.pid` is gone, or, without a pid record, if nothing in it changed for longer than the 900 s token TTL. A run still in progress, in this or another lane, is never touched. A run package calls it at start.

- **Provider-failure probe (T5):** a take that checks the app's own failure path passes `transcription: { backend: 'deepgram', minuteCap, failureProbe: 'refused-token' }` instead of a grant. Only that exact value is accepted, never together with a grant or `reconnect`, and never on a capture-only launch; a grant object that claims to be a probe is refused. No key file is read and nothing is minted. At the same point where a real token would be released, the launcher writes a fixed text (`REFUSED_PROBE_TOKEN` in `scripts/cue-lab-deepgram.mjs`) through the same owner-only file rules. It has the shape the app's token file accepts but is no credential, so the app connects as usual and Deepgram is expected to refuse it (401, code `auth`). If the app ever reports `connected` for it, the run stops: that is not the take the plan asked for. The receipt reports `failureProbe` (null for a real token) and `grantTtlS: null`, and the evidence manifest records the probe in place of the grant TTL, so a probe take cannot be read as a normal one. After the refusal the app ends the session itself, so the take ends `stopped`. Its result is in the [evidence report](lab-evidence-report.md#existing-native-timing-import), not in the take's outcome. No probe has been run against Deepgram.

Tests use a loopback grant stand-in and dummy keys; the probe tests use a fixture child that refuses the fixed text as the provider would.

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
