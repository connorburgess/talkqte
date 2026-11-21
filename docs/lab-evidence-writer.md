# Private fictional recording evidence

`createLabEvidenceWriter` is an explicit development-run writer, not normal app
logging. It creates one unique 0700 directory outside the canonical checkout and
0600 event, manifest and copied-artifact files. It neither launches anything nor
constructs a provider. Use only approved fictional input. No inference, audio,
window observation or recording is established by writing a log.

The event/manifest schemas match the offline evidence report contract. Explicit
`fictional: true` is mandatory. Default metadata mode allows identities, clocks,
stages, outcomes and cue origin (`phrase_rule` or `model`). Retaining spoken text,
transcript, trusted role instructions/input or a validated response requires
`contentMode: 'fictional-content'`. Only those content fields are accepted;
recursive auth/nonce/key/environment/hidden-reasoning fields are refused. This
key filter is defense in depth, not a detector for secrets hidden in prose. The
caller must supply only approved fictional content, never credentials or real
meeting information.

## Capture observations

Register an unanchored monotonic clock named `node`. Pass `observe` to the capture
driver as a bounded synchronous function that requires `writer.emit(event)` to
return true. Pass `onGuard` to `writer.recordGuard`. Observer failure stops the
take; independent cleanup still runs. The first terminal cause is latched: runtime,
source, protocol, deadline, observer and guard errors remain failure even when
cleanup succeeds. Explicit user Stop, SIGINT/SIGTERM and external abort remain
cancelled; later abort-induced work rejection cannot overwrite that cause. Cleanup
failure is independent and always reports failure. No raw error text is retained.
A size/event failure emits one terminal gap,
notifies `onFailure` once, refuses later events and remains failed in the manifest.
Connect that notification to the run's root abort. Do not ignore a false return.

The driver records run start/end, historical source Listening receipt, recorder
frame-accepted receipt, measured mapped audio-render start, and receipt of
validated audio completion. Receipt uncertainty zero describes sampling the local
receipt clock only; it does not assign zero uncertainty to the underlying event.
The render start retains its measured mapping uncertainty. Completion receipt is
not an exact final rendered-sample timestamp. Numeric guard receipts preserve
native-start/deadline, request/budget, actual anchor/uncertainty, media duration,
reserve and remaining time. Runtime Node/libuv/platform versions are recorded.

No recording clock anchor is fabricated. Native clocks must be declared separately;
authenticated source/session calibration is not automatically a video mapping.
Publication is not paint. `video.cue-painted`/`cleared` requires independently
observed recording-frame timing. A report must leave unobserved stages and
cross-clock mappings unknown. The first capture-only run has no evaluator/provider
observations. Later model-run admission/return/settlement hooks remain separate
work, not inferred from native request/result logs.

## Sealed artifacts and limits

After native release and recorder completed-file finalization, `attach` copies a
caller-asserted `sealed: true` artifact into the evidence directory, preserving the
source. Canonical source paths, no symlinks, bounded streaming reads, stable file
identity/timestamps and SHA256 are required. The flag is an explicit ownership
assertion, not filesystem proof that another process has stopped writing. Never
attach an active timing writer or recorder output.

Native timing retention requires fictional-content mode. Its JSONL is checked for
complete bounded UTF-8 rows, duplicate keys, explicit wrong run IDs and forbidden
fields; raw lexical numeric identities are preserved for the report importer.
Unsupported native rows remain in the copied artifact. The importer reports its
own normalized/unmapped coverage. A missing final newline is a failure, not a
silently discarded tail.

Default limits are 4 MiB per event/native file, 16 MiB combined nonvideo data and
10,000 total event/native rows. Hard configuration ceilings are 16 MiB/file,
64 MiB nonvideo and 50,000 rows. One event and 1 KiB are reserved for a terminal gap.
Recordings are streamed separately up to 4 GiB; no video is buffered in memory.
A file copy rejects observed growth/change/overflow, removes its partial target
and fails the writer. These are writer/observer bounds, not a native writer quota
or a hard bound on external recordings, polling overshoot or disk usage during
cleanup. Copies consume additional disk space.

`close` flushes, hashes and closes the event file, writes the manifest once, and
returns the same result on repeated successful calls. Expiry defaults to seven
days, with a maximum thirty-day declaration. **Expiry is metadata; this module
does not schedule deletion.** The owner must retain/delete private artifacts
under that policy. A failed filesystem write may leave incomplete artifacts;
missing/invalid evidence must never be promoted to a successful take.

Offline checks use fictional bytes, actual temporary filesystem artifacts and
injected capture stand-ins. No native timing, app, player, audio, model or screen
capture runs are performed by those checks. Public README is unchanged because
this introduces no end-user setup or public capability.
