# Private fictional take evidence report

The offline report joins existing artifacts after a take. It launches no model,
app, audio process or player, and does not write raw events. Missing stages remain
unknown: a useful first report needs neither a new native event nor a complete
trace. Lab owns the separate raw writer and orchestration hooks.

```sh
node scripts/cue-lab-evidence-report.mjs --manifest /private-evidence/take/manifest.json --out /private-evidence/take/report
```

The paths above are placeholders. Use an existing external directory with mode
0700, a mode-0600 manifest and mode-0600 inputs. Output is a **new** mode-0700
directory containing mode-0600 `report.json` and `report.md`. Existing reports are
not overwritten. Inputs, including the only recording, are never deleted.
Retention expiry records policy metadata; it does not authorize deletion.

The Markdown report prioritizes a recording-linked timeline, technical timing and
a human review table. Recording timecodes require a declared clock bridge.
Players may interpret media fragment links differently; the numeric timecodes
remain available. Prepared takes stay labelled prepared; they do not demonstrate
adaptive dialogue. This tool supplies evidence for review, not an aggregate
success or effectiveness score.

## Manifest v1

A manifest uses `schema: "talkqte.lab.evidence.manifest.v1"` and these fields:

| Field                    | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `runId`                  | One bounded opaque identifier for the fictional take                        |
| `fictional`              | Must be `true`                                                              |
| `mode`                   | `prepared` or `adaptive`                                                    |
| `contentMode`            | `metadata` by default; explicit `fictional-content` for detailed evidence   |
| `createdAt`, `expiresAt` | ISO date strings; expiry follows creation; metadata only                    |
| `limits`                 | Positive `maxFileBytes`, `maxTotalBytes`, `maxEvents` below the hard limits |
| `clocks`                 | Unique clock declarations described below                                   |
| `artifacts`              | Unique content-addressed input declarations                                 |
| `recording`              | Optional `{artifactId, durationMs}` referencing a recording artifact        |
| `reviews`                | Optional human judgments described below                                    |

Each artifact has `{id, kind, path, sha256, bytes, clockId?}`. Kinds are `events`
(normalized JSONL), `native-timing` (existing timing JSONL), or `recording`.
Paths are relative to the manifest directory; traversal, symlinked artifacts,
nonregular files and files inside this module's checkout are rejected. Files must
match their declared byte count and SHA-256. The tool verifies the recording by
streaming its bytes without decoding or loading it into memory. Native timing
artifacts must name their logger `clockId`. Clocks and artifacts are capped at 64
and 128 respectively. The manifest is capped at 256 KiB; nonmedia artifacts at
16 MiB each and 64 MiB in total, with at most 50,000 input rows/events. The manifest
may narrow those limits. Recordings have a separate 4 GiB verification ceiling;
output JSON plus Markdown is capped at 32 MiB. Exceeding a limit fails rather than
silently truncating evidence. No cleanup or retention deletion is implemented.

A minimal partial-log manifest looks like this. Replace the example identity
placeholders with the exact file's byte count and SHA-256 before use:

```json
{
  "schema": "talkqte.lab.evidence.manifest.v1",
  "runId": "fictional-cedar-01",
  "fictional": true,
  "mode": "prepared",
  "contentMode": "metadata",
  "createdAt": "2026-01-01T00:00:00Z",
  "expiresAt": "2026-02-01T00:00:00Z",
  "limits": {
    "maxFileBytes": 1048576,
    "maxTotalBytes": 2097152,
    "maxEvents": 1000
  },
  "clocks": [{ "id": "native-logger", "kind": "monotonic" }],
  "artifacts": [
    {
      "id": "native",
      "kind": "native-timing",
      "path": "timing.jsonl",
      "clockId": "native-logger",
      "bytes": 123,
      "sha256": "REPLACE_WITH_EXACT_SHA256"
    }
  ]
}
```

## Normalized event v1

The agreed writer envelope is:

```json
{
  "schema": "talkqte.lab.evidence.event.v1",
  "eventId": "broker:17",
  "runId": "fictional-cedar-01",
  "stage": "evaluator.returned",
  "outcome": "quiet",
  "ids": {
    "sessionId": "18446744073709551615",
    "requestId": "1",
    "contextRevision": "2"
  },
  "timing": {
    "clockId": "broker",
    "atMs": 4200,
    "uncertaintyMs": 1,
    "basis": "receipt"
  },
  "artifactId": "broker-events"
}
```

`artifactId` may be omitted in a file: the loader binds it to that declared file.
A supplied different identity is rejected. `timing` is optional, never invented.
Identifiers are bounded ASCII tokens (letters, digits, underscore, dot, colon,
hyphen; start with a letter or digit; at most 120 characters). Session, request
and context revision are instead canonical positive decimal u64 **strings**.
They are never rounded JavaScript numbers. `ids` additionally permits `cueId`,
`lineId`, `segmentId`. Joins require the same run and session plus exact identities.
A line-to-segment relationship requires an explicit event carrying both IDs;
matching text, ordering or proximity is insufficient. Conflicting context revisions
and duplicate stages produce unknown measurements rather than choosing a winner.

Stages:

- `speech.render-start`, `speech.render-end`: actual audio observations, not
  synthesis duration, process exit or scheduled playback.
- `transcript.arrived`, `transcript.finalized`: distinct observations; arrival does
  not imply a separately measured ASR finalization.
- `evaluator.requested`, `evaluator.admitted`, `evaluator.dispatched`,
  `evaluator.responded`, `evaluator.returned`, `evaluator.validated`,
  `evaluator.settled`, `evaluator.result`.
- `cue.decided`, `cue.published`, `cue.cleared`: runtime snapshot state.
- `video.cue-painted`, `video.cue-cleared`: independently observed recording
  frames, requiring a recording clock and `basis: "frame"`.
- `source.listening`, `recorder.frame-accepted`, `run.started`, `run.ended`, `gap`.

Outcomes are `observed`, `show`, `quiet`, `resolved`, `withdraw`, `failure`,
`stale`, `cancelled`, `unknown`. A gap may carry `payload: {dropped: 7}`; absent
counts remain unknown. Request outcomes are not interchangeable: a stale success
is not a published cue, and quiet is not automatically correct.

Provider return after adapter cleanup is `returned`, not a fabricated response
instant. Rust settlement acknowledgment received in JS is `settled` with receipt
basis, not an exact native validation timestamp. Caller-provided timestamps and
identity bridges are trusted evidence declarations; schema validation cannot prove
that they describe a real observation.

## Clocks and technical metrics

Clock declarations contain `{id, kind, sessionId?, anchor?}`. Kinds are `recording`,
`monotonic`, `native-session`; a native session clock must bind its session ID.
Recording clocks use milliseconds relative to the recording. Other clocks need
an explicit measured anchor for recording-relative and cross-clock calculations:

```json
{
  "id": "player",
  "kind": "monotonic",
  "anchor": {
    "clockMs": 10000,
    "recordingMs": 500,
    "uncertaintyMs": 12,
    "validFromMs": 10000,
    "validToMs": 120000
  }
}
```

The report does not equate native logger `mono_ms`, wall time, engine session
elapsed time, JS performance time or playback start. Anchor validity must cover
the whole event uncertainty interval. There is no extrapolation beyond the declared
range or implicit zero origin. A single anchor does not prove a drift guarantee:
the adapter must justify its validity range and uncertainty. Same-clock durations
remain measurable without a recording bridge. Basis is `event`, `receipt`, `frame`
or `scheduled`; scheduled timing does not count as actual measurement.

Metrics retain endpoint event IDs and worst-case summed uncertainty, with minimum
and maximum durations. Negative chronology is unknown; intervals overlapping zero
are marked uncertain. A zero declared uncertainty is not physical accuracy proof.

| Metric               | Exact endpoints                                         |
| -------------------- | ------------------------------------------------------- |
| Transcription lag    | Explicitly joined heard/render end → transcript arrival |
| Gate wait            | Evaluator requested → admitted                          |
| Model duration       | Dispatched → actual response observation                |
| Dispatch to returned | Dispatched → adapter returned; may include cleanup      |
| Publication delay    | Validated → cue published                               |
| Publication to paint | Published → observed paint frame                        |
| Visible duration     | Observed paint → observed clear frame                   |
| End-to-end latency   | Explicitly joined heard/render end → observed paint     |

Missing endpoints, ambiguous relationships or absent clock bridges remain unknown.
A heard/render-end endpoint must use actual `event` basis. A validated completion
receipt remains in the timeline, labelled receipt only, but cannot establish
transcription lag or heard-end-to-paint latency. Other observed receipt stages
retain their own timing semantics. Visible duration is not extended to recording
end when no clear frame was observed.

The optional manifest `writer` status is limited in reports to boolean `failed`
and nonnegative integer `dropped` (at most the declared event limit). A missing
writer status remains unavailable. This declaration is shown independently of gap
rows: when writing the gap itself fails, a sealed manifest can still retain the
failure. Do not add writer and event-gap counts, which may describe the same loss.
Other writer metadata is not copied.

Native artifacts may carry `snapshotCoverage` from a bounded post-release snapshot.
The report validates its run, copied hash/bytes/rows, cutoff/omitted/unobserved byte
counters, receipt clock and explicit `completeRunCoverage: false`,
`unknownLateRecords: true`, `nativeWriterMayRemainOpen: true`. It retains and
displays these limits separately from emitted event gaps. A zero gap count does
not establish a complete timeline. Row-limited unparsed tails remain unknown.
Coverage never establishes a native flush, app exit or recording clock bridge.
The report omits absolute source paths and inode details; original private
manifests retain that provenance.

## Existing native timing import

The importer reads existing `segment`, `evaluation_requested`, `evaluation_result`,
`cue_decision`, `cue_published`, `cue_cleared` and `dropped` rows. Other native rows
remain in the original artifact but are not normalized by this version. An
explicit native `run_id` must match the manifest even on an otherwise unmapped row. Native rows without a run field rely on the manifest's file-to-run declaration;
the importer cannot independently prove that provenance. Input summaries count
normalized and unmapped rows separately, without treating unmapped rows as dropped.
Numeric session/request u64 tokens are preserved using Node 22 JSON reviver source text.
Imported timing uses the declared native logger clock and `mono_ms`, with 1 ms
quantization uncertainty; it does not infer playback or session clock anchors.

Segments become transcript arrival, including their `accepted` flag. Native
requested becomes requested, not shared-gate admission. Native result becomes
result; its `latency_ms` is retained separately as native-reported latency, never
as model duration. In lab mode a result may also carry `action` (the decision on
a `stale` or late-timeout result that was not applied) or, on an applied decision,
`through_segment`, `lag_lines` and `lag_ms`. The report shows the unapplied action
and, per evaluation and per cue, how many lines and milliseconds the applied
decision lagged the newest speech. Malformed or mixed fields are refused. There
is no separate dispatch/response/validation/finalization instant in those native
rows. Queued `audio_received` and its amplitude flag do
not establish rendered speech. Cue publication does not establish video paint.
Unknown or unsupported stages are listed as missing; explicit dropped rows remain
evidence-loss markers. The original artifact remains the source for other rows.

**Cloud transcription rows (#344).** The importer also reads four kinds of row:

- `evaluator` becomes `evaluator.connection`, with its approval, state, backend and engine session.
- A live `session` start becomes `session.started`, with its session clock reading.
- `stt_state` becomes `transcription.stream`, with the state (`started`, `dropping`, `finished`, `ended` or `stopped`), the fixed stop code (only on `stopped`; `lab_ended` when the lab cue run ends) and `audio_ms`.
- `stt_final` becomes `transcript.finalized`, with its sequence and the start and end of speech on the session clock.

The provider's speaker label is untrusted: it is dropped on import and never reported or scored.

When the manifest records the launcher's `transcription` settings (backend, minute cap, grant TTL and the app's fixed query, never the token), or the rows include a stream, the report adds a cloud transcription section. Per session it gives:

- whether every stream start comes after that session's in-app review row (`approval` `review`, state `on`) in file order;
- whether the send queue overflowed (`dropping`);
- the last stop state and code;
- the most audio sent.

It also gives the total audio sent across the launch, against the minute cap, which covers every session and source.

For each final, it gives the delay from its end of speech to the arrival of its transcript line (`c{session}-{stream}-{seq}`, matched only when exactly one line has that session and sequence). The end of speech is placed on the logger clock through the session's start row. Malformed rows or settings are refused, not guessed. The app does not log the stream URL, so the query is evidence of what the app is built to send, not a capture of traffic.

## Human product review and private content

`reviews` entries contain `{ids, labels, note?, nextChange?, comparison?}`. Labels
are human judgments only: `grounded`, `useful`, `late`, `already answered`,
`unsupported`, `distracting`, `quiet appropriate`. The report leaves unreviewed
requests and cues blank. Add an observation about user benefit, one bounded change,
and scenario/build/content differences for the next comparison. One take provides
no matched comparison or automatic effectiveness score.

Normal reports omit rich payload content. To retain approved fictional spoken
lines, transcript, actual model request context and validated response, both
`contentMode: "fictional-content"` and CLI `--fictional-content` (or API
`includeContent: true`) are required. Only `spokenText`, `transcriptText`, `request`
and `validatedResponse` are included, with bounded text/structured sizes. The
request and validated response reject secret/auth/environment/hidden-reasoning key
names recursively. This is an accidental-field guard, not a secret detector:
the evidence producer must never supply credentials, nonce, authentication data,
environment dumps, secrets or hidden reasoning, including inside strings. Raw
provider output is not retained by this report. Safe metadata is limited to dropped
counts, accepted flags, native-reported latency and `decider: "phrase_rule" | "model"`.
The native cue-decision decider is preserved in the timeline and cue table. Absent
or ambiguous decider evidence remains unknown; evaluation presence or absence does
not establish cue provenance. Deterministic phrase cues must be labelled as such.

These files remain private, external and fictional. Do not commit recordings,
transcripts, actual private paths or generated reports. Existing app and normal
lab cue-text redaction are unchanged. No new native content logging is required.

## Acceptance and remaining blocker

Metadata-only synthetic writer-file snapshots in `scripts/fixtures/lab-evidence-writer-v1`
were emitted by writer commit `994a280` with creation/expiry dates normalized. They
exercise actual sealed manifest/event loading, including receipt-only completion
and a manifest-only failed gap write. The partial-snapshot fixture was emitted by
snapshot/writer commit `745b3d6`; its source path/inode and timestamps were
fictionalized. It verifies complete-prefix bytes and missing late coverage through
the actual sealed-file loader. These snapshots contain no meeting content or
recording.

Deterministic synthetic fixtures exercise complete and partial timelines, exact
u64 identities, missing/invalid bridges, stale/failure/quiet separation, dropped
rows, ambiguous relationships, private-file boundaries, tampering and content
opt-in. This establishes offline reporting behavior only. Actual streamed speech,
source capture, transcription, model cues, window paint, clock calibration and
recording completeness still require a separately coordinated integrated take.
The next bounded acceptance check is to import that take's existing artifacts,
inspect its timecodes against recording frames and complete human product labels.
No roadmap capability is marked complete by this tool.
