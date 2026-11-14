# Local per-line voice adapter

`createLocalVoice` in `scripts/cue-lab-local-voice.mjs` implements the file-synthesis
contract consumed by the [adaptive body](lab-adaptive-take.md). It opens no audio
device and supplies no player, capture source or provider. Import and construction
run no subprocess. Actual synthesis remains a separately coordinated runtime
check; the tests use only stand-ins and mocked OS primitives.

## Explicit configuration

Supply an exact speaker-to-installed-voice map, a fixed integer rate of 80–240
words per minute and an explicit `execution` mode. `local-say` is macOS-only and
uses the fixed `/usr/bin/say` command; it refuses runner injection.
`offline-stand-in` requires an explicitly injected `run` and never selects a real
runner. There is no automatic mode, hosted TTS, provider fallback, alternate voice,
tone/silence fallback, retry or speedup to fit a planned slot.

The first line performs one bounded `say -v ?` installed-voice query. Every pinned
voice must be listed exactly; missing voices stop the adapter. It then invokes
the pinned voice/rate with file output, mono 48 kHz little-endian signed 16-bit PCM
WAVE. Text is supplied through stdin, not argv, shell interpolation or a persisted
text file. Speech markup delimiters and control characters are refused so line
text cannot change rate or inject synthesis commands. Only PATH and the existing
HOME location are inherited; provider credentials and arbitrary runtime overrides
are not passed to the child.

This uses the documented `say` file/input/audio-format options, inspected through
the local manual. No actual installed-voice listing, synthesis, format compatibility
or system voice engine behavior was checked by this change. There is no code to
download voices or call a speech service. Confirm the pinned installed voice and
local engine behavior during the separate native acceptance.

## Line identity and files

`synthesizeLine({runId,lineId,speaker,text,signal,deadlineAt})` matches the injected
adaptive interface. A voice object binds to its first run ID, refuses reused line
IDs and admits only one active line. A concurrent caller gets `busy` without
cancelling the first operation. Every other failure is terminal; close or a failed
session cannot be reset by changing caller state or supplying another identity.

One successful line returns immutable
`{runId,lineId,speaker,textSha256,clipSha256,path,durationMs,sampleRate,channels}`.
The UTF-8 text hash binds the exact words, and clip SHA256 covers the validated
file. File names are random rather than supplied IDs. A unique canonical directory
outside the module checkout has mode 0700; files are precreated exclusively with
mode 0600 and checked for ownership, identity, symlinks, mode and changes during
reading. Temporary parents inside the checkout or aliases into it are refused,
independently of caller cwd. Only the adapter's own directory is removed by close.

The bounded in-process probe checks RIFF length, one supported PCM format and one
nonempty aligned data chunk. It rejects truncated, duplicate, compressed, stereo,
wrong-rate and overlong output. The maximum clip is 4 MiB by default (hard ceiling
8 MiB), duration 30 seconds by default (ceiling 60 seconds). Validated files have
a cumulative 16 MiB default budget (ceiling 64 MiB), and at most 100 line attempts.
Those budgets never reset. The consumer must not mutate the clip and must finish
reading/playback before normal voice cleanup removes retained files.

File duration and successful process exit are synthesis evidence only. They never
acknowledge heard speech, actual playback start/end, captured audio, transcription,
model cue/silence decisions or companion paint.

## Bounded process ownership and cleanup

The effective operation deadline is the earlier of caller `deadlineAt` and the
pinned `timeoutMs` (30 seconds by default, maximum 60 seconds), across voice query,
synthesis and validation. The runner bounds combined stdout/stderr to 16 KiB and
never exposes raw diagnostics. It uses one direct detached owned process group,
no shell, and no audio-device or network-send argument. Abort, output overflow,
deadline or observed file-limit violation terminates that group. A TERM request
escalates to KILL after 100 ms; missing child/pipe settlement after 500 ms is failed
cleanup. A successful child also has its remaining group retired and absence
checked for up to 100 ms. Signal delivery and parent exit alone are not release.

The writer's size/mode is polled every 10 ms, then the finished file is read with
a fixed allocation bounded by its verified size. **Polling is not a hard disk
quota:** output can overshoot between polls or before termination. No native
writer byte cap is claimed. Over-limit/changed evidence is terminal, and no file
is returned. Whole-take storage planning must account for this bounded-observation
limitation and possible failed cleanup.

`close()` reserves one cached promise before abort callbacks, prevents new work,
waits for the active operation and removes the owned files. Cleanup failure wins
over an earlier Stop/cancellation and remains a rejected close; it is never
reported as successful retirement. The enclosing playback session retains player,
provider and native cleanup ownership. A noncooperative injected stand-in runner
can prevent settlement; it is not a valid runtime adapter.

## Offline checks and next acceptance

```sh
node --test scripts/cue-lab-local-voice.test.mjs
```

Tests cover voice/rate pinning, exact file/text identity, privacy/cleanup, markup
refusal, missing voices, malformed PCM, count/storage continuity, concurrency,
abort/deadline/output failures, symlink/replacement rejection and process-group
cleanup failure. Process tests mock spawn and group signalling; none launches a
child, say, audio, provider, player or app. POSIX ownership/permission/group tests
are skipped on Windows and establish no Windows synthesis support.

The next acceptance check is a separately authorized bounded local synthesis with
the pinned voice/rate, actual file validation and confirmed process cleanup. A
capturable incremental player, actual playback acknowledgements and native capture
still remain separate dependencies. This internal adapter changes no app journey
or public release capability.
