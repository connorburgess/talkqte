// Offline evidence joining only. This module never launches a provider or deletes inputs.
import { constants } from 'node:fs';
import { open, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  dirname,
  basename,
  resolve,
  relative,
  isAbsolute,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { DEEPGRAM_APP_QUERY, isAllowedSttQuery } from './cue-lab-deepgram.mjs';

export const EVENT_SCHEMA = 'talkqte.lab.evidence.event.v1';
export const MANIFEST_SCHEMA = 'talkqte.lab.evidence.manifest.v1';
const STAGES = new Set([
  'speech.render-start',
  'speech.render-end',
  'transcript.arrived',
  'transcript.finalized',
  ...[
    'requested',
    'admitted',
    'dispatched',
    'responded',
    'returned',
    'validated',
    'settled',
    'result',
  ].map((s) => `evaluator.${s}`),
  // The native model connection turning on or off, and how it was approved.
  'evaluator.connection',
  // A live native session starting: anchors its session clock to mono time.
  'session.started',
  // Cloud transcription stream start/stop with its fixed code and audio sent.
  'transcription.stream',
  // The native capture source failing (source_problem), and TalkQTE's own
  // owned-player identity check failing, recovering or ending it.
  'source.problem',
  'source.check',
  'cue.decided',
  'cue.published',
  'cue.cleared',
  'video.cue-painted',
  'video.cue-cleared',
  'source.listening',
  'recorder.frame-accepted',
  'run.started',
  'run.ended',
  'gap',
]);
const OUTCOMES = new Set([
  'observed',
  'show',
  'quiet',
  'resolved',
  'withdraw',
  'failure',
  'stale',
  'cancelled',
  // Direct API route non-decisions for one request: a provider refusal, and
  // a reply that reached its output bound (native outcome output_limit).
  'refused',
  'output_limit',
  'unknown',
]);
const LABELS = new Set([
  'grounded',
  'useful',
  'late',
  'already answered',
  'unsupported',
  'distracting',
  'quiet appropriate',
]);
const ID_KEYS = [
  'sessionId',
  'requestId',
  'contextRevision',
  'cueId',
  'lineId',
  'segmentId',
];
const U64 = new Set(['sessionId', 'requestId', 'contextRevision']);
const HARD = {
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEvents: 50000,
};
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => {
  throw new Error(message);
};
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value) =>
  Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 4;
const token = (value) =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value);
const text = (value, max = 2000) =>
  typeof value === 'string' &&
  value.length <= max &&
  !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
function ids(value = {}) {
  if (!object(value) || Object.keys(value).some((k) => !ID_KEYS.includes(k)))
    fail('invalid identity fields');
  for (const [key, v] of Object.entries(value)) {
    if (U64.has(key)) {
      if (
        typeof v !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(v) ||
        BigInt(v) > 18446744073709551615n
      )
        fail(`invalid ${key}: use decimal u64 string`);
    } else if (!token(v)) fail(`invalid ${key}`);
  }
  return { ...value };
}
function unique(items, key) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) fail(`duplicate ${key}`);
    seen.add(item[key]);
  }
}
// Snapshot coverage describes an incomplete prefix, never native flush/exit.
// Keep private source paths/inode details in the original manifest only.
function snapshotCoverage(artifact, manifest) {
  const c = artifact.snapshotCoverage;
  if (c === undefined) return null;
  const counters = [
    'observedBytesAtOpen',
    'observedBytesAtEnd',
    'cutoffBytes',
    'readBytes',
    'copiedBytes',
    'rows',
    'omittedBytesAtCutoff',
    'unobservedBytesAtOpen',
  ];
  if (
    !object(c) ||
    artifact.kind !== 'native-timing' ||
    c.schema !== 'talkqte.lab.timing-snapshot.v1' ||
    c.runId !== manifest.runId ||
    !(c.sourceEnd === 'native-ended'
      ? c.sourceReleaseObserved === false &&
        /^[a-z_]{1,40}$/.test(c.nativeEndProblem ?? '')
      : (c.sourceEnd === undefined || c.sourceEnd === 'released') &&
        c.sourceReleaseObserved === true &&
        c.nativeEndProblem === undefined) ||
    c.recorderFinalizationObserved !== true ||
    c.nativeWriterMayRemainOpen !== true ||
    c.completeRunCoverage !== false ||
    c.unknownLateRecords !== true ||
    !counters.every((k) => Number.isSafeInteger(c[k]) && c[k] >= 0) ||
    c.rows > manifest.limits.maxEvents ||
    typeof c.grewDuringCopy !== 'boolean' ||
    typeof c.rowLimitReached !== 'boolean' ||
    (c.rowLimitReached
      ? c.trailingPartialBytes !== null
      : !Number.isSafeInteger(c.trailingPartialBytes) ||
        c.trailingPartialBytes < 0) ||
    c.observedBytesAtEnd < c.observedBytesAtOpen ||
    c.copiedBytes > c.readBytes ||
    c.readBytes > c.cutoffBytes ||
    c.cutoffBytes > c.observedBytesAtOpen ||
    c.omittedBytesAtCutoff !== c.cutoffBytes - c.copiedBytes ||
    c.unobservedBytesAtOpen !== c.observedBytesAtOpen - c.cutoffBytes ||
    c.sha256 !== artifact.sha256 ||
    c.copiedBytes !== artifact.bytes ||
    !object(c.cutoffReceipt) ||
    !manifest.clocks.some(
      (clock) =>
        clock.id === c.cutoffReceipt.clockId && clock.kind === 'monotonic',
    ) ||
    !number(c.cutoffReceipt.atMs) ||
    c.cutoffReceipt.basis !== 'receipt'
  )
    fail('invalid snapshot coverage');
  return {
    schema: c.schema,
    ...Object.fromEntries(counters.map((k) => [k, c[k]])),
    sourceReleaseObserved: c.sourceReleaseObserved,
    sourceEnd: c.sourceEnd ?? 'released',
    ...(c.nativeEndProblem ? { nativeEndProblem: c.nativeEndProblem } : {}),
    recorderFinalizationObserved: true,
    nativeWriterMayRemainOpen: true,
    completeRunCoverage: false,
    unknownLateRecords: true,
    grewDuringCopy: c.grewDuringCopy,
    rowLimitReached: c.rowLimitReached,
    trailingPartialBytes: c.trailingPartialBytes,
    cutoffReceipt: {
      clockId: c.cutoffReceipt.clockId,
      atMs: c.cutoffReceipt.atMs,
      basis: 'receipt',
    },
    sha256: c.sha256,
  };
}
export function validateManifest(m) {
  if (
    !object(m) ||
    m.schema !== MANIFEST_SCHEMA ||
    !token(m.runId) ||
    m.fictional !== true ||
    !['prepared', 'adaptive'].includes(m.mode) ||
    !['metadata', 'fictional-content'].includes(m.contentMode)
  )
    fail('invalid fictional evidence manifest');
  if (
    typeof m.createdAt !== 'string' ||
    typeof m.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    !Number.isFinite(Date.parse(m.expiresAt)) ||
    Date.parse(m.expiresAt) <= Date.parse(m.createdAt)
  )
    fail('invalid retention metadata');
  for (const [key, cap] of Object.entries(HARD))
    if (
      !Number.isSafeInteger(m.limits?.[key]) ||
      m.limits[key] < 1 ||
      m.limits[key] > cap
    )
      fail(`invalid ${key}`);
  if (
    !Array.isArray(m.clocks) ||
    m.clocks.length > 64 ||
    !Array.isArray(m.artifacts) ||
    m.artifacts.length > 128
  )
    fail('invalid clocks/artifacts');
  unique(m.clocks, 'id');
  unique(m.artifacts, 'id');
  for (const c of m.clocks) {
    if (
      !token(c.id) ||
      !['recording', 'monotonic', 'native-session'].includes(c.kind)
    )
      fail('invalid clock');
    if (c.kind === 'native-session') ids({ sessionId: c.sessionId });
    if (c.anchor) {
      const a = c.anchor;
      if (
        ![
          'clockMs',
          'recordingMs',
          'uncertaintyMs',
          'validFromMs',
          'validToMs',
        ].every((k) => number(a[k])) ||
        a.validFromMs > a.clockMs ||
        a.clockMs > a.validToMs
      )
        fail('invalid clock anchor');
    }
  }
  for (const a of m.artifacts) {
    if (
      !token(a.id) ||
      !['events', 'native-timing', 'recording'].includes(a.kind) ||
      typeof a.path !== 'string' ||
      isAbsolute(a.path) ||
      a.path.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') ||
      /[\x00-\x1f]/.test(a.path) ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 0
    )
      fail('invalid artifact');
    if (a.clockId && !m.clocks.some((c) => c.id === a.clockId))
      fail('unknown artifact clock');
    if (a.kind === 'native-timing' && !a.clockId)
      fail('native timing needs logger clock');
    snapshotCoverage(a, m);
  }
  if (
    m.recording &&
    (!m.artifacts.some(
      (a) => a.id === m.recording.artifactId && a.kind === 'recording',
    ) ||
      !number(m.recording.durationMs))
  )
    fail('invalid recording');
  if (
    m.writer !== undefined &&
    (!object(m.writer) ||
      typeof m.writer.failed !== 'boolean' ||
      !Number.isSafeInteger(m.writer.dropped) ||
      m.writer.dropped < 0 ||
      m.writer.dropped > m.limits.maxEvents)
  )
    fail('invalid writer status');
  if (
    m.reviews !== undefined &&
    (!Array.isArray(m.reviews) || m.reviews.length > 1000)
  )
    fail('invalid reviews');
  // Cloud transcription settings the launcher used: never the token.
  if (
    m.transcription !== undefined &&
    (!object(m.transcription) ||
      Object.keys(m.transcription).sort().join() !==
        'backend,grantTtlS,minuteCap,query' ||
      m.transcription.backend !== 'deepgram' ||
      !Number.isSafeInteger(m.transcription.minuteCap) ||
      m.transcription.minuteCap < 1 ||
      m.transcription.minuteCap > 60 ||
      !Number.isSafeInteger(m.transcription.grantTtlS) ||
      m.transcription.grantTtlS < 300 ||
      m.transcription.grantTtlS > 3600 ||
      m.transcription.query !== DEEPGRAM_APP_QUERY)
  )
    fail('invalid transcription settings');
  for (const r of m.reviews ?? []) {
    ids(r.ids);
    if (!Array.isArray(r.labels) || r.labels.some((l) => !LABELS.has(l)))
      fail('invalid human labels');
    for (const k of ['note', 'nextChange', 'comparison'])
      if (r[k] !== undefined && !text(r[k])) fail('invalid review text');
  }
  return m;
}
function validateEvent(e, m) {
  if (
    !object(e) ||
    e.schema !== EVENT_SCHEMA ||
    e.runId !== m.runId ||
    !token(e.eventId) ||
    !STAGES.has(e.stage) ||
    !OUTCOMES.has(e.outcome)
  )
    fail('invalid event envelope');
  ids(e.ids);
  if (e.artifactId && !m.artifacts.some((a) => a.id === e.artifactId))
    fail('unknown event artifact');
  if (e.timing) {
    const t = e.timing,
      c = m.clocks.find((c) => c.id === t.clockId);
    if (
      !c ||
      !number(t.atMs) ||
      !number(t.uncertaintyMs) ||
      !['event', 'receipt', 'frame', 'scheduled'].includes(t.basis)
    )
      fail('invalid event timing');
    if (c.kind === 'native-session' && c.sessionId !== e.ids?.sessionId)
      fail('session clock mismatch');
    if (
      e.stage.startsWith('video.') &&
      (t.basis !== 'frame' || c.kind !== 'recording')
    )
      fail('paint requires independently observed recording frame');
  }
  if (
    e.payload?.decider !== undefined &&
    !['phrase_rule', 'model'].includes(e.payload.decider)
  )
    fail('invalid cue decider');
  if (e.stage.startsWith('video.') && !e.timing)
    fail('paint requires frame timing');
  if (
    e.stage === 'gap' &&
    e.payload?.dropped !== undefined &&
    (!Number.isSafeInteger(e.payload.dropped) || e.payload.dropped < 1)
  )
    fail('invalid dropped count');
  return e;
}
// JSON.parse source preserves numeric native u64 identity before any Number rounding.
export function parseNativeRow(line) {
  return JSON.parse(line, (key, value, context) => {
    if (['session', 'request'].includes(key) && typeof value === 'number') {
      if (!context?.source || !/^\d+$/.test(context.source))
        fail('native identity requires lexical JSON source');
      return context.source;
    }
    return value;
  });
}
export function importNativeRows(rows, { runId, artifactId, clockId }) {
  const events = [];
  for (const [index, r] of rows.entries()) {
    if (r.run_id !== undefined && r.run_id !== runId)
      fail('native run identity mismatch');
    const identity = {};
    if (r.session !== undefined) identity.sessionId = String(r.session);
    if (r.request !== undefined) identity.requestId = String(r.request);
    if (r.cue !== undefined) identity.cueId = String(r.cue);
    let stage,
      outcome = 'observed',
      payload;
    switch (r.event) {
      case 'segment':
        stage = 'transcript.arrived';
        identity.segmentId = String(r.id);
        payload = { transcriptText: r.text, accepted: r.accepted };
        break;
      case 'evaluation_requested':
        stage = 'evaluator.requested';
        if (r.through_segment !== undefined)
          identity.segmentId = String(r.through_segment);
        break;
      case 'evaluation_result': {
        stage = 'evaluator.result';
        outcome = r.outcome === 'failed' ? 'failure' : r.outcome;
        payload = { nativeReportedLatencyMs: r.latency_ms };
        // Lab-only native fields: `action` on a decision that was not applied
        // (stale or a late timeout), or the bounded-staleness trio on an
        // applied decision. Never both; the trio is all-or-nothing.
        const lag = ['through_segment', 'lag_lines', 'lag_ms'].filter(
          (k) => r[k] !== undefined,
        );
        if (r.action !== undefined) {
          // Only a decision that was not applied: stale, or read after timeout.
          if (
            !DECISION_ACTIONS.has(r.action) ||
            lag.length ||
            !(
              r.outcome === 'stale' ||
              (r.outcome === 'failed' && r.failure === 'timeout')
            )
          )
            fail('invalid native decision action');
          payload.decisionAction = r.action;
        }
        if (lag.length) {
          if (
            lag.length !== 3 ||
            !DECISION_ACTIONS.has(r.outcome) ||
            !SEGMENT_ID.test(r.through_segment ?? '') ||
            !Number.isSafeInteger(r.lag_lines) ||
            r.lag_lines < 0 ||
            !Number.isSafeInteger(r.lag_ms) ||
            r.lag_ms < 0 ||
            (r.lag_lines === 0 && r.lag_ms !== 0)
          )
            fail('invalid native decision staleness');
          payload.throughSegment = r.through_segment;
          payload.lagLines = r.lag_lines;
          payload.lagMs = r.lag_ms;
        }
        break;
      }
      case 'evaluator':
        if (
          !['review', 'launchSetting'].includes(r.approval) ||
          !['on', 'off'].includes(r.state) ||
          !/^[A-Za-z0-9._-]{1,64}$/.test(r.backend ?? '')
        )
          fail('invalid native connection row');
        stage = 'evaluator.connection';
        payload = {
          approval: r.approval,
          connectionState: r.state,
          backend: r.backend,
        };
        break;
      case 'session':
        if (r.live !== true || r.state !== 'started') continue;
        if (!number(r.elapsed_ms)) fail('invalid native session row');
        stage = 'session.started';
        payload = { sessionElapsedMs: r.elapsed_ms };
        break;
      case 'stt_state':
        if (
          !STT_STATES.has(r.state) ||
          (r.code !== undefined && !STT_CODES.has(r.code)) ||
          (r.state === 'stopped') !== (r.code !== undefined) ||
          (r.state === 'connected') !== isAllowedSttQuery(r.query) ||
          !Number.isSafeInteger(r.audio_ms) ||
          r.audio_ms < 0
        )
          fail('invalid native transcription state row');
        stage = 'transcription.stream';
        payload = {
          sttState: r.state,
          ...(r.code !== undefined ? { sttCode: r.code } : {}),
          ...(r.query !== undefined ? { query: r.query } : {}),
          audioMs: r.audio_ms,
        };
        break;
      case 'source_problem':
        if (
          !FIXED_LABEL.test(r.problem ?? '') ||
          (r.os_code !== undefined && !Number.isSafeInteger(r.os_code))
        )
          fail('invalid native source problem row');
        // Only the fixed label and OS code; any detail stays in the original.
        stage = 'source.problem';
        payload = {
          sourceProblem: r.problem,
          ...(r.os_code !== undefined ? { osCode: r.os_code } : {}),
        };
        break;
      case 'lab_source_check':
        if (
          !['failing', 'recovered', 'ended'].includes(r.state) ||
          !FIXED_LABEL.test(r.check ?? '') ||
          !Number.isSafeInteger(r.after_ms) ||
          r.after_ms < 0
        )
          fail('invalid native lab source check row');
        stage = 'source.check';
        payload = {
          checkState: r.state,
          check: r.check,
          afterMs: r.after_ms,
        };
        break;
      case 'stt_final':
        if (
          ![r.seq, r.start_ms, r.end_ms].every(Number.isSafeInteger) ||
          r.seq < 0 ||
          r.start_ms < 0 ||
          r.end_ms < r.start_ms
        )
          fail('invalid native transcription final row');
        // The provider's speaker label is untrusted: never carried forward.
        stage = 'transcript.finalized';
        payload = { sttSeq: r.seq, startMs: r.start_ms, endMs: r.end_ms };
        break;
      case 'cue_decision':
        stage = 'cue.decided';
        if (r.decider !== undefined) payload = { decider: r.decider };
        if (r.source_id !== undefined) identity.segmentId = String(r.source_id);
        break;
      case 'cue_published':
        stage = 'cue.published';
        break;
      case 'cue_cleared':
        stage = 'cue.cleared';
        break;
      case 'dropped':
        stage = 'gap';
        payload = { dropped: r.count };
        break;
      default:
        continue;
    }
    events.push({
      schema: EVENT_SCHEMA,
      eventId: `${artifactId}:${index + 1}`,
      runId,
      stage,
      outcome,
      ids: identity,
      artifactId,
      ...(number(r.mono_ms)
        ? {
            timing: {
              clockId,
              atMs: r.mono_ms,
              uncertaintyMs: 1,
              basis: 'event',
            },
          }
        : {}),
      ...(payload ? { payload } : {}),
    });
  }
  return events;
}
function mapped(e, m) {
  const t = e?.timing;
  if (!t || t.basis === 'scheduled') return null;
  const c = m.clocks.find((c) => c.id === t.clockId);
  if (c.kind === 'recording')
    return m.recording && t.atMs > m.recording.durationMs
      ? null
      : { atMs: t.atMs, uncertaintyMs: t.uncertaintyMs };
  const a = c.anchor;
  if (
    !a ||
    t.atMs - t.uncertaintyMs < a.validFromMs ||
    t.atMs + t.uncertaintyMs > a.validToMs
  )
    return null;
  const atMs = a.recordingMs + t.atMs - a.clockMs;
  return atMs < 0 || (m.recording && atMs > m.recording.durationMs)
    ? null
    : { atMs, uncertaintyMs: t.uncertaintyMs + a.uncertaintyMs };
}
const successful = (e) =>
  e && !['failure', 'stale', 'cancelled', 'unknown'].includes(e.outcome);
function duration(start, end, m) {
  const unknown = (reason) => ({ status: 'unknown', reason });
  if (!start || !end) return unknown('missing stage');
  if (!successful(start) || !successful(end))
    return unknown('unsuccessful endpoint');
  const a = start.timing,
    b = end.timing;
  if (!a || !b || a.basis === 'scheduled' || b.basis === 'scheduled')
    return unknown('missing actual timing');
  if (
    [start, end].some(
      (e) => e.stage === 'speech.render-end' && e.timing.basis !== 'event',
    )
  )
    return unknown('heard end requires actual event timing');
  let delta, uncertainty;
  if (a.clockId === b.clockId) {
    delta = b.atMs - a.atMs;
    uncertainty = a.uncertaintyMs + b.uncertaintyMs;
  } else {
    const x = mapped(start, m),
      y = mapped(end, m);
    if (!x || !y) return unknown('missing valid clock bridge');
    delta = y.atMs - x.atMs;
    uncertainty = x.uncertaintyMs + y.uncertaintyMs;
  }
  if (delta < 0) return unknown('reversed chronology');
  return {
    status: delta < uncertainty ? 'uncertain' : 'measured',
    valueMs: delta,
    uncertaintyMs: uncertainty,
    minMs: Math.max(0, delta - uncertainty),
    maxMs: delta + uncertainty,
    startEventId: start.eventId,
    endEventId: end.eventId,
  };
}
const key = (e, kind) =>
  e.ids?.sessionId && e.ids?.[kind]
    ? `${e.ids.sessionId}/${e.ids[kind]}`
    : null;
const DECISION_ACTIONS = new Set(['show', 'quiet', 'resolved', 'withdraw']);
// `dropping`: written once when the send queue first overflows.
const FIXED_LABEL = /^[a-z_]{1,40}$/;
const STT_STATES = new Set([
  'started',
  // Connected to the provider, with the query of the URL actually used.
  'connected',
  'dropping',
  'finished',
  'ended',
  'stopped',
]);
const STT_CODES = new Set([
  'auth',
  'quota',
  'rate_limited',
  'cap_reached',
  'network',
  'protocol',
  'closed',
  'settings',
  'withdrawn',
  'lab_ended',
  // No reply from the service for 10 s, or a write held over 3 s (#344).
  'stalled',
]);
// Native segment identities such as `t1-0-4`; never free text.
const SEGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// How far behind the current transcript an applied lab decision was.
const staleness = (result) =>
  result?.payload?.lagLines === undefined
    ? null
    : {
        throughSegment: result.payload.throughSegment,
        lagLines: result.payload.lagLines,
        lagMs: result.payload.lagMs,
      };
const lagText = (s) =>
  s
    ? `${escape(s.throughSegment)} / ${s.lagLines} / ${s.lagMs} ms`
    : 'not reported';
const pick = (events, stage) => {
  const found = events.filter((e) => e.stage === stage);
  return found.length === 1 ? found[0] : null;
};
function safePayload(payload, includeContent) {
  if (!object(payload)) return undefined;
  const result = {};
  if (DECISION_ACTIONS.has(payload.decisionAction))
    result.decisionAction = payload.decisionAction;
  if (
    SEGMENT_ID.test(payload.throughSegment ?? '') &&
    Number.isSafeInteger(payload.lagLines) &&
    Number.isSafeInteger(payload.lagMs)
  ) {
    result.throughSegment = payload.throughSegment;
    result.lagLines = payload.lagLines;
    result.lagMs = payload.lagMs;
  }
  if (Number.isSafeInteger(payload.dropped)) result.dropped = payload.dropped;
  if (['phrase_rule', 'model'].includes(payload.decider))
    result.decider = payload.decider;
  if (typeof payload.accepted === 'boolean') result.accepted = payload.accepted;
  if (['review', 'launchSetting'].includes(payload.approval))
    result.approval = payload.approval;
  if (['on', 'off'].includes(payload.connectionState))
    result.connectionState = payload.connectionState;
  if (/^[A-Za-z0-9._-]{1,64}$/.test(payload.backend ?? ''))
    result.backend = payload.backend;
  if (STT_STATES.has(payload.sttState)) result.sttState = payload.sttState;
  if (FIXED_LABEL.test(payload.sourceProblem ?? ''))
    result.sourceProblem = payload.sourceProblem;
  if (Number.isSafeInteger(payload.osCode)) result.osCode = payload.osCode;
  if (['failing', 'recovered', 'ended'].includes(payload.checkState))
    result.checkState = payload.checkState;
  if (FIXED_LABEL.test(payload.check ?? '')) result.check = payload.check;
  if (STT_CODES.has(payload.sttCode)) result.sttCode = payload.sttCode;
  if (isAllowedSttQuery(payload.query)) result.query = payload.query;
  for (const k of [
    'afterMs',
    'audioMs',
    'sttSeq',
    'startMs',
    'endMs',
    'sessionElapsedMs',
  ])
    if (Number.isSafeInteger(payload[k]) && payload[k] >= 0)
      result[k] = payload[k];
  if (number(payload.nativeReportedLatencyMs))
    result.nativeReportedLatencyMs = payload.nativeReportedLatencyMs;
  if (includeContent) {
    // Deliberate allowlist: no arbitrary raw provider objects, environment or reasoning.
    for (const k of ['spokenText', 'transcriptText'])
      if (text(payload[k], 16000)) result[k] = payload[k];
    for (const k of ['request', 'validatedResponse'])
      if (payload[k] !== undefined) {
        const serialized = JSON.stringify(payload[k]);
        if (serialized.length > 64000) fail('content payload too large');
        const check = (value) => {
          if (!object(value) && !Array.isArray(value)) return;
          for (const [name, child] of Object.entries(value)) {
            if (
              /auth|credential|secret|nonce|token|password|environment|^env$|reasoning|chain.of.thought/i.test(
                name,
              )
            )
              fail('forbidden private evidence key');
            check(child);
          }
        };
        check(payload[k]);
        result[k] = payload[k];
      }
  }
  return Object.keys(result).length ? result : undefined;
}
// Cloud transcription evidence, from native rows only: the settings used,
// whether each stream opened only after the in-app review, how it stopped,
// audio sent against the cap, and each final's delay from its end of speech
// (session clock, bridged through the session's start row) to the arrival
// of its transcript line.
function cloudSummary(events, m) {
  const streamEvents = events.filter((e) => e.stage === 'transcription.stream');
  const finals = events.filter((e) => e.stage === 'transcript.finalized');
  if (!m.transcription && !streamEvents.length && !finals.length) return null;
  const index = new Map(events.map((e, i) => [e, i]));
  // The review row carries the same engine session as the stream rows.
  const firstReview = (sessionId) =>
    events.findIndex(
      (e) =>
        e.stage === 'evaluator.connection' &&
        e.payload?.approval === 'review' &&
        e.payload?.connectionState === 'on' &&
        (sessionId === undefined || e.ids?.sessionId === sessionId),
    );
  // The minute cap covers the whole launch: every session and source.
  const capMs = m.transcription ? m.transcription.minuteCap * 60000 : null;
  const sessions = [
    ...new Set(streamEvents.map((e) => e.ids?.sessionId ?? null)),
  ];
  const streams = sessions.map((sessionId) => {
    const own = streamEvents.filter(
      (e) => (e.ids?.sessionId ?? null) === sessionId,
    );
    const starts = own.filter((e) => e.payload?.sttState === 'started');
    const stops = own.filter(
      (e) =>
        !['started', 'connected', 'dropping'].includes(e.payload?.sttState),
    );
    const connected = own.filter((e) => e.payload?.sttState === 'connected');
    const query = connected.length === 1 ? connected[0].payload.query : null;
    const last = stops.at(-1) ?? null;
    const audioMs = Math.max(0, ...own.map((e) => e.payload?.audioMs ?? 0));
    const review = firstReview(sessionId ?? undefined);
    return {
      sessionId,
      starts: starts.length,
      startedAfterReview:
        starts.length > 0 &&
        review >= 0 &&
        starts.every((e) => index.get(e) > review),
      connected: connected.length === 1,
      // The query of the URL the app actually used, and whether it is the
      // one the lab expects (opt-out included).
      query,
      queryMatchesExpected:
        query === null || !m.transcription
          ? null
          : query === m.transcription.query,
      // The send queue overflowed at least once: some audio was not sent.
      dropping: own.some((e) => e.payload?.sttState === 'dropping'),
      stopState: last?.payload?.sttState ?? null,
      stopCode: last?.payload?.sttCode ?? null,
      audioMs,
    };
  });
  const audioMs = streams.reduce((n, s) => n + s.audioMs, 0);
  const arrivals = events.filter((e) => e.stage === 'transcript.arrived');
  const finalRows = finals.map((f) => {
    const sessionId = f.ids?.sessionId ?? null;
    const seq = f.payload?.sttSeq;
    const pattern = new RegExp(`^c${sessionId}-[0-9]+-${seq}$`);
    const matches = arrivals.filter(
      (a) => a.ids?.sessionId === sessionId && pattern.test(a.ids?.segmentId),
    );
    const arrival = matches.length === 1 ? matches[0] : null;
    const starts = events.filter(
      (e) => e.stage === 'session.started' && e.ids?.sessionId === sessionId,
    );
    const start = starts.length === 1 ? starts[0] : null;
    let finalToSegmentMs = null;
    if (
      arrival?.timing &&
      start?.timing &&
      arrival.timing.clockId === start.timing.clockId &&
      Number.isSafeInteger(f.payload?.endMs)
    )
      finalToSegmentMs =
        arrival.timing.atMs -
        (start.timing.atMs +
          (f.payload.endMs - start.payload.sessionElapsedMs));
    return {
      eventId: f.eventId,
      sessionId,
      seq: seq ?? null,
      segmentId: arrival?.ids?.segmentId ?? null,
      endMs: f.payload?.endMs ?? null,
      finalToSegmentMs,
    };
  });
  const delays = finalRows
    .map((r) => r.finalToSegmentMs)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  return {
    settings: m.transcription ? { ...m.transcription } : null,
    reviewRowSeen: firstReview() >= 0,
    streams,
    audioMs,
    capMs,
    withinCap: capMs === null ? null : audioMs <= capMs,
    finals: finalRows,
    finalToSegment: {
      count: delays.length,
      medianMs: delays.length ? delays[Math.floor(delays.length / 2)] : null,
      maxMs: delays.length ? delays.at(-1) : null,
      basis:
        'native session clock bridged through the session start row; about ±2 ms of logging resolution',
    },
  };
}
/**
 * Whether the native capture source held: every source problem (with
 * ScreenCaptureKit's -3815 "source_gone" told apart from TalkQTE's own
 * "lab_source_lost") and every identity-check transition. It held only if
 * there was no problem, no check ended it, and every check that went
 * failing later recovered.
 */
export function summarizeSourceHealth(events) {
  const problems = events
    .filter((e) => e.stage === 'source.problem')
    .map((e) => ({
      eventId: e.eventId,
      problem: e.payload.sourceProblem,
      osCode: e.payload.osCode ?? null,
    }));
  const checks = events
    .filter((e) => e.stage === 'source.check')
    .map((e) => ({
      eventId: e.eventId,
      state: e.payload.checkState,
      check: e.payload.check,
      afterMs: e.payload.afterMs,
    }));
  const open = new Set();
  for (const c of checks) {
    if (c.state === 'failing') open.add(c.check);
    else open.delete(c.check);
  }
  return {
    problems,
    checks,
    unrecovered: [...open],
    held:
      problems.length === 0 &&
      !checks.some((c) => c.state === 'ended') &&
      open.size === 0,
  };
}
/** The same summary straight from parsed native timing rows. */
export function sourceHealthFromNativeRows(rows, { runId }) {
  return summarizeSourceHealth(
    importNativeRows(rows, { runId, artifactId: 'native', clockId: 'native' }),
  );
}
export function buildEvidenceReport(
  manifest,
  input,
  { includeContent = false, inputSummary = [] } = {},
) {
  const m = validateManifest(manifest);
  if (includeContent && m.contentMode !== 'fictional-content')
    fail('content requires explicit fictional-content manifest');
  if (!Array.isArray(input) || input.length > m.limits.maxEvents)
    fail('event limit exceeded');
  const events = input.map((e) => validateEvent(e, m));
  unique(events, 'eventId');
  const gaps = events
    .filter((e) => e.stage === 'gap')
    .map((e) => ({ eventId: e.eventId, dropped: e.payload?.dropped ?? null }));
  const requests = new Map(),
    cues = new Map(),
    segments = new Map(),
    lines = new Map();
  for (const e of events) {
    for (const [map, kind] of [
      [requests, 'requestId'],
      [cues, 'cueId'],
      [segments, 'segmentId'],
      [lines, 'lineId'],
    ]) {
      const k = key(e, kind);
      if (k) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
      }
    }
  }
  const ambiguities = [];
  for (const [kind, map] of [
    ['request', requests],
    ['cue', cues],
  ]) {
    for (const [identity, group] of map) {
      for (const stage of new Set(group.map((e) => e.stage))) {
        const duplicates = group.filter((e) => e.stage === stage);
        if (duplicates.length > 1)
          ambiguities.push({
            kind,
            identity,
            stage,
            eventIds: duplicates.map((e) => e.eventId),
          });
      }
    }
  }
  const transcription = events
    .filter((e) => e.stage === 'transcript.arrived')
    .map((arrival) => {
      // Exact identity bridge only. Neither matching text nor array position is evidence.
      const links = (segments.get(key(arrival, 'segmentId')) ?? []).filter(
        (e) => e.ids?.lineId,
      );
      const lineIds = [...new Set(links.map((e) => e.ids.lineId))];
      const heard =
        lineIds.length === 1
          ? pick(
              lines.get(`${arrival.ids.sessionId}/${lineIds[0]}`) ?? [],
              'speech.render-end',
            )
          : null;
      return {
        eventId: arrival.eventId,
        ids: arrival.ids,
        lag: duration(heard, arrival, m),
      };
    });
  const evaluations = [...requests].map(([id, group]) => {
    const revisions = new Set(
      group.map((e) => e.ids.contextRevision).filter(Boolean),
    );
    const ambiguous = revisions.size > 1;
    const one = (stage) => (ambiguous ? null : pick(group, stage));
    const stages = Object.fromEntries(
      [...STAGES]
        .filter((s) => s.startsWith('evaluator.'))
        .map((s) => [s, one(s)?.eventId ?? null]),
    );
    const result = one('evaluator.result') ?? one('evaluator.settled');
    return {
      id,
      ambiguous,
      outcome: result?.outcome ?? 'unknown',
      stages,
      gateWait: duration(
        one('evaluator.requested'),
        one('evaluator.admitted'),
        m,
      ),
      modelDuration: duration(
        one('evaluator.dispatched'),
        one('evaluator.responded'),
        m,
      ),
      returnedAfterDispatch: duration(
        one('evaluator.dispatched'),
        one('evaluator.returned'),
        m,
      ),
      nativeReportedLatencyMs:
        one('evaluator.result')?.payload?.nativeReportedLatencyMs ?? null,
      unappliedAction: one('evaluator.result')?.payload?.decisionAction ?? null,
      staleness: staleness(one('evaluator.result')),
    };
  });
  const cloudTranscription = cloudSummary(events, m);
  const sourceHealth = summarizeSourceHealth(events);
  const cueRows = [...cues].map(([id, group]) => {
    const published = pick(group, 'cue.published'),
      painted = pick(group, 'video.cue-painted');
    const requestIds = [
      ...new Set(group.map((e) => key(e, 'requestId')).filter(Boolean)),
    ];
    let request =
      requestIds.length === 1 ? (requests.get(requestIds[0]) ?? []) : [];
    if (
      new Set(request.map((e) => e.ids.contextRevision).filter(Boolean)).size >
      1
    )
      request = [];
    const segmentIds = [
      ...new Set(
        [...group, ...request].map((e) => e.ids?.segmentId).filter(Boolean),
      ),
    ];
    const lineIds =
      segmentIds.length === 1
        ? [
            ...new Set(
              (segments.get(`${group[0].ids.sessionId}/${segmentIds[0]}`) ?? [])
                .filter((e) => e.ids?.lineId)
                .map((e) => e.ids.lineId),
            ),
          ]
        : [];
    const heard =
      lineIds.length === 1
        ? pick(
            lines.get(`${group[0].ids.sessionId}/${lineIds[0]}`) ?? [],
            'speech.render-end',
          )
        : null;
    const decision = pick(group, 'cue.decided');
    return {
      id,
      decider: successful(decision)
        ? (decision.payload?.decider ?? 'unknown')
        : 'unknown',
      requestId: requestIds.length === 1 ? requestIds[0] : null,
      publication: successful(published) ? 'observed' : 'unobserved',
      paint: successful(painted) ? 'observed' : 'unobserved',
      publicationDelay: duration(
        pick(request, 'evaluator.validated'),
        published,
        m,
      ),
      publicationToPaint: duration(published, painted, m),
      staleness: staleness(pick(request, 'evaluator.result')),
      visibleDuration: duration(painted, pick(group, 'video.cue-cleared'), m),
      endToEnd: duration(heard, painted, m),
    };
  });
  const timeline = events.map((e) => {
    const payload = safePayload(e.payload, includeContent);
    return {
      eventId: e.eventId,
      stage: e.stage,
      outcome: e.outcome,
      ids: { ...e.ids },
      artifactId: e.artifactId ?? null,
      timing: e.timing
        ? {
            clockId: e.timing.clockId,
            atMs: e.timing.atMs,
            uncertaintyMs: e.timing.uncertaintyMs,
            basis: e.timing.basis,
          }
        : null,
      recording: mapped(e, m),
      ...(payload ? { payload } : {}),
    };
  });
  // Unknown mappings retain source order at the end; never pretend different clocks are ordered.
  timeline.sort(
    (a, b) => (a.recording?.atMs ?? Infinity) - (b.recording?.atMs ?? Infinity),
  );
  const reviews = [
    ...(m.reviews ?? []).map((r) => ({
      ids: ids(r.ids),
      labels: [...r.labels],
      note: r.note ?? '',
      nextChange: r.nextChange ?? '',
      comparison: r.comparison ?? '',
      origin: 'human',
    })),
  ];
  const reviewedRequests = new Set(
    reviews.map((r) => `${r.ids?.sessionId}/${r.ids?.requestId}`),
  );
  const reviewedCues = new Set(
    reviews.map((r) => `${r.ids?.sessionId}/${r.ids?.cueId}`),
  );
  for (const e of evaluations)
    if (!reviewedRequests.has(e.id)) {
      const [sessionId, requestId] = e.id.split('/');
      reviews.push({
        ids: { sessionId, requestId },
        labels: [],
        note: '',
        nextChange: '',
        comparison: '',
        origin: 'unreviewed',
      });
    }
  for (const c of cueRows)
    if (!reviewedCues.has(c.id)) {
      const [sessionId, cueId] = c.id.split('/');
      reviews.push({
        ids: { sessionId, cueId },
        labels: [],
        note: '',
        nextChange: '',
        comparison: '',
        origin: 'unreviewed',
      });
    }
  return {
    schema: 'talkqte.lab.evidence.report.v1',
    runId: m.runId,
    mode: m.mode,
    fictional: true,
    contentIncluded: includeContent,
    retention: {
      expiresAt: m.expiresAt,
      policy: 'metadata only; originals preserved; no automatic deletion',
    },
    recording: m.recording
      ? {
          artifactId: m.recording.artifactId,
          durationMs: m.recording.durationMs,
          path: m.artifacts.find((a) => a.id === m.recording.artifactId).path,
        }
      : null,
    inputSummary: inputSummary.map((s) => {
      if (
        !m.artifacts.some((a) => a.id === s.artifactId) ||
        !['rows', 'normalizedEvents', 'unmappedNativeRows'].every(
          (k) =>
            Number.isSafeInteger(s[k]) &&
            s[k] >= 0 &&
            s[k] <= m.limits.maxEvents,
        )
      )
        fail('invalid input summary');
      return {
        artifactId: s.artifactId,
        rows: s.rows,
        normalizedEvents: s.normalizedEvents,
        unmappedNativeRows: s.unmappedNativeRows,
      };
    }),
    evidence: m.artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      sha256: a.sha256,
      bytes: a.bytes,
      ...(a.snapshotCoverage
        ? { snapshotCoverage: snapshotCoverage(a, m) }
        : {}),
    })),
    gaps,
    writerStatus: m.writer
      ? { failed: m.writer.failed, dropped: m.writer.dropped }
      : null,
    ambiguities,
    missingEvidence: [...STAGES].filter(
      (s) => !events.some((e) => e.stage === s),
    ),
    counts: Object.fromEntries(
      [...OUTCOMES].map((o) => [
        o,
        events.filter((e) => e.stage === 'evaluator.result' && e.outcome === o)
          .length,
      ]),
    ),
    transcription,
    cloudTranscription,
    sourceHealth,
    evaluations,
    cues: cueRows,
    timeline,
    reviews,
    limitations: [
      'Technical timing does not establish user benefit.',
      'Quiet requires human review; publication does not establish paint.',
      'One take does not establish a matched comparison.',
      'Prepared media is not adaptive dialogue.',
      'Event timestamps have declared uncertainty; zero does not prove physical accuracy.',
    ],
  };
}
const escape = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll('|', '&#124;')
    .replaceAll('\n', ' ');
const metric = (m) =>
  m.status === 'unknown'
    ? `unknown (${m.reason})`
    : `${Math.round(m.valueMs)} ± ${Math.round(m.uncertaintyMs)} ms${m.status === 'uncertain' ? ' (uncertain order)' : ''}`;
function cloudMarkdown(c) {
  return [
    '### Cloud transcription',
    '',
    c.settings
      ? `Settings: ${escape(c.settings.backend)}, cap ${c.settings.minuteCap} min, grant TTL ${c.settings.grantTtlS} s; expected query: \`${escape(c.settings.query)}\`. The token is not evidence.`
      : 'Settings: not recorded in the manifest.',
    '',
    `In-app review row seen: ${c.reviewRowSeen}.`,
    '',
    '| Session | Starts | Started only after its review | Connected | Query used = expected | Send queue overflowed | Stop state / code | Audio sent |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...c.streams.map(
      (s) =>
        `| ${escape(s.sessionId ?? 'unknown')} | ${s.starts} | ${s.startedAfterReview} | ${s.connected} | ${s.queryMatchesExpected ?? 'unknown'} | ${s.dropping} | ${s.stopState ?? 'none'} / ${s.stopCode ?? 'none'} | ${s.audioMs} ms |`,
    ),
    '',
    ...c.streams
      .filter((s) => s.query)
      .map(
        (s) =>
          `Session ${escape(s.sessionId)} query used: \`${escape(s.query)}\``,
      ),
    '',
    `Audio sent this launch: ${c.audioMs} ms against a cap of ${c.capMs ?? 'unknown'} ms (the cap covers every session and source).`,
    '',
    `Final end of speech → transcript line: ${c.finalToSegment.count} finals; median ${c.finalToSegment.medianMs ?? 'unknown'} ms, max ${c.finalToSegment.maxMs ?? 'unknown'} ms (${c.finalToSegment.basis}). The provider's speaker label is untrusted and not reported.`,
    '',
  ];
}
export function renderEvidenceMarkdown(r, { recordingHref } = {}) {
  const time = (e) =>
    e.recording
      ? `${(e.recording.atMs / 1000).toFixed(3)}s ±${e.recording.uncertaintyMs}ms`
      : 'unknown';
  const link = (e) =>
    e.recording && recordingHref
      ? `[${time(e)}](${recordingHref}#t=${(e.recording.atMs / 1000).toFixed(3)})`
      : time(e);
  return [
    `# Fictional take ${escape(r.runId)}`,
    '',
    `Mode: **${r.mode}**. Content: ${r.contentIncluded ? 'explicit fictional evidence' : 'metadata only'}.`,
    '',
    ...r.limitations.map((s) => `- ${s}`),
    '',
    `Retention expiry: ${escape(r.retention.expiresAt)}; ${r.retention.policy}.`,
    '',
    '## Evidence gaps',
    '',
    r.writerStatus
      ? `Writer-reported status: failed=${r.writerStatus.failed}; dropped=${r.writerStatus.dropped}. This declaration is independent of gap rows; do not add the counts.`
      : 'Writer-reported status: unavailable.',
    '',
    `Dropped-event reports: ${r.gaps.length}; known dropped events: ${r.gaps.reduce((n, g) => n + (g.dropped ?? 0), 0)}. Unknown counts remain unknown.`,
    '',
    `Missing stages: ${r.missingEvidence.join(', ') || 'none'}.`,
    '',
    `Ambiguous repeated stages: ${r.ambiguities.length}; inspect endpoint event IDs in JSON rather than selecting a result.`,
    '',
    '| Input artifact | Rows | Normalized events | Unmapped native rows (preserved in original) |',
    '| --- | --- | --- | --- |',
    ...r.inputSummary.map(
      (s) =>
        `| ${escape(s.artifactId)} | ${s.rows} | ${s.normalizedEvents} | ${s.unmappedNativeRows} |`,
    ),
    '',
    '### Native snapshot limits',
    '',
    r.evidence.some((a) => a.snapshotCoverage)
      ? 'Snapshot coverage is independent of emitted event gaps. Each snapshot has completeRunCoverage=false and unknownLateRecords=true; the timeline is incomplete and the native writer may remain open.'
      : 'No snapshot coverage supplied; complete timeline coverage is not established.',
    '',
    '| Artifact | Source end | Copied / cutoff / observed at open (bytes) | Omitted at cutoff / unobserved at open (bytes) | Rows / trailing partial bytes | Row limit / grew during copy |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.evidence
      .filter((a) => a.snapshotCoverage)
      .map((a) => {
        const c = a.snapshotCoverage;
        return `| ${escape(a.id)} | ${c.sourceEnd === 'native-ended' ? `ended by native (${escape(c.nativeEndProblem)}), not released by Stop` : 'released by Stop'} | ${c.copiedBytes} / ${c.cutoffBytes} / ${c.observedBytesAtOpen} | ${c.omittedBytesAtCutoff} / ${c.unobservedBytesAtOpen} | ${c.rows} / ${c.trailingPartialBytes ?? 'unknown'} | ${c.rowLimitReached} / ${c.grewDuringCopy} |`;
      }),
    '',
    '## Per-take timeline',
    '',
    '| Recording time | Timing basis | Stage / outcome | Identities | Evidence event |',
    '| --- | --- | --- | --- | --- |',
    ...r.timeline.map(
      (e) =>
        `| ${link(e)} | ${e.timing?.basis === 'receipt' ? 'receipt only (not event time)' : (e.timing?.basis ?? 'unknown')} | ${e.stage} / ${e.outcome} | ${escape(JSON.stringify(e.ids))} | ${escape(e.eventId)} |`,
    ),
    '',
    '## Technical measurements',
    '',
    '| Evaluation | Outcome | Gate wait | Model dispatch → response | Dispatch → returned (includes adapter cleanup) | Unapplied decision action | Evaluated through / lines behind / ms behind |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.evaluations.map(
      (e) =>
        `| ${escape(e.id)}${e.ambiguous ? ' (ambiguous context)' : ''} | ${e.outcome} | ${metric(e.gateWait)} | ${metric(e.modelDuration)} | ${metric(e.returnedAfterDispatch)} | ${e.unappliedAction ?? 'none'} | ${lagText(e.staleness)} |`,
    ),
    '',
    r.evaluations.some((e) => e.staleness)
      ? 'Lab decisions may be applied to a transcript that grew while the model replied (bounded staleness, within the native evaluator deadline). Lines and ms behind show how far each applied decision lagged the newest speech; a cue can reflect speech that newer lines already answered.'
      : 'No applied decision reported staleness fields.',
    '',
    '| Cue / declared decider | Publication / paint | Validated → published | Visible duration | Heard end → paint | Evaluated through / lines behind / ms behind |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.cues.map(
      (c) =>
        `| ${escape(c.id)} / ${c.decider} | ${c.publication} / ${c.paint} | ${metric(c.publicationDelay)} | ${metric(c.visibleDuration)} | ${metric(c.endToEnd)} | ${lagText(c.staleness)} |`,
    ),
    '',
    ...(r.cloudTranscription ? cloudMarkdown(r.cloudTranscription) : []),
    '### Capture source',
    '',
    `Source held to the end: ${r.sourceHealth.held}. Source problems: ${r.sourceHealth.problems.map((p) => `${escape(p.problem)}${p.osCode === null ? '' : ` (${p.osCode})`}`).join(', ') || 'none'}. Unrecovered checks: ${r.sourceHealth.unrecovered.map(escape).join(', ') || 'none'}. Identity-check transitions: ${r.sourceHealth.checks.map((c) => `${c.state} ${escape(c.check)} after ${c.afterMs} ms`).join('; ') || 'none'}.`,
    '',
    '| Transcript event | Heard end → arrival |',
    '| --- | --- |',
    ...r.transcription.map(
      (t) => `| ${escape(t.eventId)} | ${metric(t.lag)} |`,
    ),
    '',
    '## Human product review',
    '',
    'Labels describe human judgments, not automatic scores. Compare a later take only after recording scenario, version and change differences.',
    '',
    '| Identities | Recording | Human labels | Observation / user benefit | Next bounded change | Comparison plan / differences |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.reviews.map(
      (v) =>
        `| ${escape(JSON.stringify(v.ids))} | ${(() => {
          const first = r.timeline.find(
            (e) =>
              e.recording &&
              Object.entries(v.ids).every(([k, value]) => e.ids[k] === value),
          );
          return first ? link(first) : 'unknown';
        })()} | ${escape(v.labels.join(', ') || 'unreviewed')} | ${escape(v.note)} | ${escape(v.nextChange)} | ${escape(v.comparison)} |`,
    ),
    '',
    ...(r.contentIncluded
      ? [
          '## Explicit fictional content',
          '',
          ...r.timeline
            .filter((e) => e.payload)
            .map(
              (e) =>
                `- ${escape(e.eventId)}: ${escape(JSON.stringify(e.payload))}`,
            ),
          '',
        ]
      : []),
  ].join('\n');
}
function outside(path) {
  const rel = relative(checkout, path);
  if (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  )
    fail('evidence must be outside checkout');
}
async function privateRoot(path) {
  const canonical = await realpath(path);
  outside(canonical);
  const s = await stat(canonical);
  if (!s.isDirectory() || (s.mode & 0o777) !== 0o700)
    fail('private evidence directory requires mode 0700');
  return canonical;
}
async function boundedFile(path, max) {
  const f = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await f.stat();
    if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.size > max)
      fail('invalid private file mode/type/size');
    const data = Buffer.alloc(s.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await f.read(
        data,
        length,
        data.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await f.stat();
    if (
      length !== s.size ||
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs
    )
      fail('evidence changed during read');
    return data.subarray(0, length);
  } finally {
    await f.close();
  }
}
export async function loadEvidence(manifestPath) {
  const root = await privateRoot(dirname(resolve(manifestPath)));
  const manifestFile = resolve(root, basename(manifestPath));
  if ((await realpath(manifestFile)) !== manifestFile)
    fail('manifest aliases unsupported');
  const m = validateManifest(
    JSON.parse((await boundedFile(manifestFile, 256 * 1024)).toString('utf8')),
  );
  const events = [];
  const inputSummary = [];
  let total = 0;
  let rawRows = 0;
  for (const a of m.artifacts) {
    const path = resolve(root, a.path);
    const canonical = await realpath(path);
    if (!canonical.startsWith(root + sep) || canonical !== path)
      fail('artifact alias/escape');
    // Recordings may be large: verify identity by bounded streaming, never load media into RAM.
    const max = a.kind === 'recording' ? 4 * 1024 ** 3 : m.limits.maxFileBytes;
    if (a.bytes > max) fail('artifact size limit');
    const f = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const hash = createHash('sha256');
    const chunks = [];
    let bytes = 0;
    try {
      const before = await f.stat();
      if (
        !before.isFile() ||
        (before.mode & 0o777) !== 0o600 ||
        before.size !== a.bytes
      )
        fail('artifact mode/type/size mismatch');
      for await (const chunk of f.createReadStream({
        autoClose: false,
        highWaterMark: 65536,
      })) {
        bytes += chunk.length;
        if (bytes > a.bytes || bytes > max) fail('artifact exceeds bound');
        hash.update(chunk);
        if (a.kind !== 'recording') chunks.push(chunk);
      }
      const after = await f.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        fail('artifact changed during read');
    } finally {
      await f.close();
    }
    if (bytes !== a.bytes || hash.digest('hex') !== a.sha256)
      fail('artifact hash mismatch');
    if (a.kind === 'recording') continue;
    total += bytes;
    if (total > m.limits.maxTotalBytes) fail('total input limit');
    const lines = Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim());
    if (a.snapshotCoverage && lines.length !== a.snapshotCoverage.rows)
      fail('snapshot row count mismatch');
    rawRows += lines.length;
    if (rawRows > m.limits.maxEvents) fail('event limit exceeded');
    const previousCount = events.length;
    if (a.kind === 'native-timing')
      events.push(
        ...importNativeRows(lines.map(parseNativeRow), {
          runId: m.runId,
          artifactId: a.id,
          clockId: a.clockId,
        }),
      );
    else
      for (const line of lines) {
        const e = JSON.parse(line);
        if (e.artifactId && e.artifactId !== a.id)
          fail('event artifact mismatch');
        events.push({ ...e, artifactId: a.id });
      }
    inputSummary.push({
      artifactId: a.id,
      rows: lines.length,
      normalizedEvents: events.length - previousCount,
      unmappedNativeRows:
        a.kind === 'native-timing'
          ? lines.length - (events.length - previousCount)
          : 0,
    });
  }
  return { manifest: m, events, root, inputSummary };
}
export async function writeEvidenceReport({
  manifestPath,
  outDir,
  includeContent = false,
}) {
  const { manifest, events, root, inputSummary } =
    await loadEvidence(manifestPath);
  const report = buildEvidenceReport(manifest, events, {
    includeContent,
    inputSummary,
  });
  const parent = await privateRoot(dirname(resolve(outDir)));
  const output = resolve(parent, basename(outDir));
  outside(output);
  const href = report.recording
    ? relative(output, resolve(root, report.recording.path))
        .split(sep)
        .map((p) =>
          encodeURIComponent(p).replaceAll('(', '%28').replaceAll(')', '%29'),
        )
        .join('/')
    : undefined;
  const json = JSON.stringify(report, null, 2) + '\n',
    markdown = renderEvidenceMarkdown(report, { recordingHref: href });
  if (Buffer.byteLength(json) + Buffer.byteLength(markdown) > 32 * 1024 * 1024)
    fail('report output limit');
  await mkdir(output, { mode: 0o700 }); // Exclusive directory creation: never overwrite inputs or prior reports.
  await writeFile(resolve(output, 'report.json'), json, {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(resolve(output, 'report.md'), markdown, {
    mode: 0o600,
    flag: 'wx',
  });
  return { output, report };
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--fictional-content') opts.includeContent = true;
      else if (args[i] === '--manifest' && args[i + 1])
        opts.manifestPath = args[++i];
      else if (args[i] === '--out' && args[i + 1]) opts.outDir = args[++i];
      else
        fail(
          'usage: --manifest FILE --out NEW_DIRECTORY [--fictional-content]',
        );
    }
    if (!opts.manifestPath || !opts.outDir)
      fail('manifest and output directory required');
    await writeEvidenceReport(opts);
    console.log('Private evidence report written.');
  } catch {
    console.error(
      'Evidence report failed validation or private file checks; no inputs deleted.',
    );
    process.exitCode = 1;
  }
}
