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
    m.reviews !== undefined &&
    (!Array.isArray(m.reviews) || m.reviews.length > 1000)
  )
    fail('invalid reviews');
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
      case 'evaluation_result':
        stage = 'evaluator.result';
        outcome = r.outcome === 'failed' ? 'failure' : r.outcome;
        payload = { nativeReportedLatencyMs: r.latency_ms };
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
const pick = (events, stage) => {
  const found = events.filter((e) => e.stage === stage);
  return found.length === 1 ? found[0] : null;
};
function safePayload(payload, includeContent) {
  if (!object(payload)) return undefined;
  const result = {};
  if (Number.isSafeInteger(payload.dropped)) result.dropped = payload.dropped;
  if (['phrase_rule', 'model'].includes(payload.decider))
    result.decider = payload.decider;
  if (typeof payload.accepted === 'boolean') result.accepted = payload.accepted;
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
    };
  });
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
    })),
    gaps,
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
    '## Per-take timeline',
    '',
    '| Recording time | Stage / outcome | Identities | Evidence event |',
    '| --- | --- | --- | --- |',
    ...r.timeline.map(
      (e) =>
        `| ${link(e)} | ${e.stage} / ${e.outcome} | ${escape(JSON.stringify(e.ids))} | ${escape(e.eventId)} |`,
    ),
    '',
    '## Technical measurements',
    '',
    '| Evaluation | Outcome | Gate wait | Model dispatch → response | Dispatch → returned (includes adapter cleanup) |',
    '| --- | --- | --- | --- | --- |',
    ...r.evaluations.map(
      (e) =>
        `| ${escape(e.id)}${e.ambiguous ? ' (ambiguous context)' : ''} | ${e.outcome} | ${metric(e.gateWait)} | ${metric(e.modelDuration)} | ${metric(e.returnedAfterDispatch)} |`,
    ),
    '',
    '| Cue / declared decider | Publication / paint | Validated → published | Visible duration | Heard end → paint |',
    '| --- | --- | --- | --- | --- |',
    ...r.cues.map(
      (c) =>
        `| ${escape(c.id)} / ${c.decider} | ${c.publication} / ${c.paint} | ${metric(c.publicationDelay)} | ${metric(c.visibleDuration)} | ${metric(c.endToEnd)} |`,
    ),
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
