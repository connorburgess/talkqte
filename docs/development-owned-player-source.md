# Development owned fictional player source

A macOS debug build with `native-audio-spike` and `lab-evaluator` supports one
identity-pinned `TalkQTE Lab Player` source in addition to the existing QuickTime
Stop mode. This is offline-tested development plumbing, not a completed recording
or a general application integration. The player, signed build receipt, recorder,
authenticated session join and coordinated runtime acceptance remain separate.

## Explicit frozen identity

The owned launcher verifies the approved player bundle/executable hash and
signature before launch, owns that exact child and freezes these settings for
TalkQTE:

| Setting | Required value |
| --- | --- |
| `TALKQTE_DEV_APPLICATION_SOURCE` | `TalkQTE Lab Player` |
| `TALKQTE_DEV_PLAYER_PID` | Canonical positive decimal PID in the signed 32-bit range |
| `TALKQTE_DEV_PLAYER_START_SEC` | Canonical positive decimal u64 process-start seconds |
| `TALKQTE_DEV_PLAYER_START_USEC` | Canonical decimal process-start microseconds, 0–999999 |
| `TALKQTE_DEV_PLAYER_EXECUTABLE` | Exact absolute canonical executable path |

The existing `usr2` Stop opt-in, shared run ID, private timing channel, consent,
session call cap and finite positive ordinary-Stop guard are also required. The
player's fixed bundle identifier is `com.talkqte.lab-player`; its name is not an
alias for QuickTime. Partial/malformed identity, unexpected player fields in a
different source mode and repeated initialization refuse setup. Settings never
reacquire a new PID or read a replacement identity from the environment.

Native setup independently checks process start time and UID with `proc_pidinfo`,
canonical `proc_pidpath`, a regular singly linked executable, file identity and
running bundle identifier. It brackets the inspection with matching process-start
reads. The launcher separately binds the approved executable/bundle/hash/signature
receipt; native checks are not another signature or content-hash attestation.

Only the SCK selection with that exact PID, bundle and application name is kept.
Helpers must be absent. The selected retained application is checked again before
creating its stream. Existing positive application inclusion and audio handling
remain unchanged; no helper expansion, unrelated application, whole-system filter
or alternative capture adapter is added. An absent SCK entry fails the attempt.

The native owner rechecks identity while polling off the callback, without
Runtime/host locks.

- **Definitive change:** the pinned process is gone (`ESRCH`), now has another
  owner or another start time, or has a changed canonical executable path or
  file identity. This cancels that exact operation at once, through the
  existing Stop/remove/serial-queue cleanup path.
- **Transient failure:** a failed read of the process information or path, an
  executable that cannot be read, a missing `NSRunningApplication` entry, its
  bundle identifier, or `isTerminated`. This ends the operation only if it keeps
  failing for two seconds; a check that passes again clears it.
  - In RunB07 (17 November 2026) a single such failure ended capture about
    0.3 s after the owner switched applications. The player was still running
    and unchanged.
  - The timing log records `lab_source_check` rows: `failing` with the check's
    name when a transient failure starts, and `recovered` with how long it
    lasted.
- **How the end is recorded:** an operation ended by this check records the
  problem `source_gone` with TalkQTE's own code 3 and no `os_code`. Its detail
  names the check, for example "lab source check running_application kept
  failing for 2 s". ScreenCaptureKit stopping the stream itself is still
  recorded with macOS's `os_code` -3815, so the two are told apart.

 Polling and admission checks have TOCTOU
windows: they do not make process lifetime or mutable filesystem state atomic,
prevent a hostile same-user replacement, or prove continuous source identity.
No timeout, process exit or name match substitutes for native release.

## Preserved Stop and observation boundaries

The [owned-process Stop handshake](development-lab-evaluator.md#stop-for-an-owned-development-process)
retains source-only admission, permanent refusal of admitted microphone history,
both microphone start gates, exact extracted-Live drain acknowledgement and host
FIFO/startup settlement. Its five-second cleanup observer, lossy event handling
and independent finite timed Stop remain unchanged. Unsupported microphone or
runner ownership cannot become `released` through this mode.

Version 1 [source observations](development-source-observation.md) use the fixed
application name `TalkQTE Lab Player` for this mode. Listening and retirement keep
the same frozen run, host operation, live operation and canonical session identity.
They remain historical guard-time observations, not atomic readiness or release.
Consumers must explicitly expect this fixed source, retain terminal observation,
and bind its session to authenticated hello/calibration before model dispatch.

## Recording acceptance still required

The first capture-only validation should use the already verified fictional
media, the reviewed signed four-feature TalkQTE build and owned player receipt,
with model connection disabled. Bound one playback to at most 110 seconds, retain
only the two approved windows and their fictional audio, stop at the first failure
or new permission prompt, and check actual render-clock acknowledgement, selected
source transcription, video frames and independent native/player/recorder cleanup.

The acceptance clock is the observed audio render/media timeline. Measured
render-to-orchestrator and broker mappings together must fit the 100 ms bound.
API-reported output presentation latency is a separate estimate with explicit
limits; it is not proof of physical acoustic arrival or speaker audibility.
Player schedule/receipt time, elapsed timers and process exit cannot replace an
actual render-clock start or distinguish natural EOF from cancelled completion.

Only after that bounded capture path is established should a separately recorded
model-enabled plan enable explicit consent and a fixed shared call cap, bind the
same source session, and compare evaluator decisions/publication to recorded
companion paint. Publication is not paint. No app launch, capture, inference,
recording, clock accuracy or cleanup measurement is established by offline tests.
