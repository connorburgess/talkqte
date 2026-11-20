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

| Setting                          | Required value                                            |
| -------------------------------- | --------------------------------------------------------- |
| `TALKQTE_DEV_APPLICATION_SOURCE` | `TalkQTE Lab Player`                                      |
| `TALKQTE_DEV_PLAYER_PID`         | Canonical positive decimal PID in the signed 32-bit range |
| `TALKQTE_DEV_PLAYER_START_SEC`   | Canonical positive decimal u64 process-start seconds      |
| `TALKQTE_DEV_PLAYER_START_USEC`  | Canonical decimal process-start microseconds, 0–999999    |
| `TALKQTE_DEV_PLAYER_EXECUTABLE`  | Exact absolute canonical executable path                  |

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

- **Definitive change:** anything that can show the pinned process was
  replaced is compared with the pin first, before any other read, and ends that
  exact operation at once through the existing Stop/remove/serial-queue cleanup
  path. That covers:
  - the process gone (`ESRCH`), or the pid now held by another user (`EPERM`);
  - a different start time, at the start or the end of the check;
  - an executable path from `proc_pidpath` other than the pinned one, for
    example after an `exec()`;
  - a canonical path that now differs from it (a symlink);
  - a link count other than one, or a different file identity;
  - a bundle identifier other than the player's.
- **Transient failure:** only a read that could not complete for the process
  already verified as the pinned one is transient: the process information,
  the path, the canonical path, the file metadata, a missing
  `NSRunningApplication` entry or bundle identifier, or `isTerminated`. It ends
  the operation only if it keeps failing for two seconds; a check that passes
  again clears it.
  - While a transient failure is tolerated, captured audio keeps flowing as
    before: to the engine and, once the session's review is approved, to cloud
    transcription. That can last up to two seconds, where before the operation
    ended at the first failed poll. This is accepted for this development-lab
    path with a fictional player, because by then the process has already been
    verified as the pinned one.
  - The product's application-audio capture has no pinned-process check, so
    this tolerance does not apply to it.
  - The timing log records `lab_source_check` rows: `failing` with the check's
    name when a transient failure starts, `recovered` with how long it lasted,
    and `ended` with the check that ended the operation.
- **How the end is recorded:** an operation ended by this check records the
  problem `lab_source_lost` with TalkQTE's own code 3 and no `os_code`. Its detail
  names the check, for example "lab source check running_application kept
  failing for 2 s". ScreenCaptureKit stopping the stream itself is still
  recorded as `source_gone` with macOS's `os_code` -3815, so the two are told
  apart by label as well as by code.

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

## Selected-context composition and acceptance

The selected-context native branch previously admitted only QuickTime in its
Stop guard and did not contain the owned-player identity prerequisites. A bound
owned-player launch therefore failed setup before broker authentication. The
forward correction composes only identity, admission, observation and owner-loop
checks with the selected-context path; it does not replace its source snapshot,
permission or provider policy. The original failed artifact remains evidence.
That deterministic refusal does not establish the cause of a separate native
exception.

The new isolated regression freezes the launch's exact owned-source settings
through the production initializer with a fictional process table, checks the
same finite-Stop admission used at setup, then runs the real host list/review/
source-session/observation/ordinary-Stop route against its scripted backend.
Missing identity, wrong owner/bundle/start/executable, repeat initialization,
unpinned name-only admission, alternate sources and missing/invalid guards
refuse. Listening and retirement retain the same kind, run, operation and session;
source admission grants no cue-processing permission. Separate identity and owner
loop regressions cover PID/file replacement, closing start-time reads, transient
recovery and Stop precedence. These tests do not create an SCK stream or a Tauri
application.

Local Rust compilation, tests and Clippy remain unrun under the preserved capacity
floor. Required acceptance is independent exact-delta review, exact-head hosted
default and feature Rust tests/Clippy plus browser checks, then a separately
reviewed fixed-source artifact workflow and manifest binding this source with the
selected API contract. A newly signed artifact and lab package preflight are
required before any separately authorized launch. Device/SCK source identity,
render clock, microphone exclusion, permission delivery and ordinary release
remain native acceptance gates; offline tests are not a successful paired run.

## Fixed startup diagnostics

A later corrected-artifact attempt armed Stop and acknowledged the owned player,
then reported `source_ended` / `unavailable` before any Listening or broker HELLO.
This is distinct from the earlier setup refusal. Retained evidence does not locate
the exact `Unavailable` call site: no startup token-placeholder metadata or child
stderr was retained. Cleanup-time absence of that file cannot establish its
startup state. The launcher creates an empty private placeholder before spawn;
native readiness checks its metadata, accepting zero bytes without reading a
credential. No deterministic mismatch in that contract has been identified.

A debug macOS lab build now prepares raw private `lab_source_startup` version 1
rows with only closed `stage` and `reason` enums:

| Stage | Reasons |
| --- | --- |
| `cloud_readiness` | `ready`, `cloud_build_missing`, `cloud_not_selected`, `cloud_settings_invalid`, `token_metadata_rejected` |
| `runtime_access` | `runtime_unavailable` |
| `runtime_start` | `runtime_refused`, `microphone_busy` |
| `session_created` | `created` |
| `recognizer_load` | `ready`, `load_refused` |

The same production checks run once in the same order; their original errors,
admission, permissions, source ownership and Stop behavior remain unchanged.
Readiness classification checks only launch configuration and file metadata. It
opens no provider connection and reads no token contents. No path, name, OS error,
internal error string, environment value, token or header enters these rows.
Runtime creation does not mean capture or provider approval. Recognizer-load
readiness does not establish a current source session; the existing post-load
session fence still decides that.

Existing JavaScript timing readers ignore this distinct event and still treat
`source_ended` / `dev_source` failures as terminal. The raw log remains the retained
diagnostic. Rows are lossy, so an absent row is not success or proof of a specific
failure. These diagnostics do not fix the observed failure, relax a guard, extend
a timeout or authorize another attempt. Inert tests exercise the actual production
admission/load helpers with scripted Runtime access, preserved refusal behavior,
and real temporary placeholder metadata; no Tauri/SCK app is created. Local Rust
execution remains unrun under the capacity floor. Exact source review and hosted
validation, followed by a separately approved diagnostic artifact and attempt,
remain required before new runtime evidence can resolve the failing gate.
