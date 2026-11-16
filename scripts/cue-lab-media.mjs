// Approved fictional media for a lab take. The trust anchor is a sha256
// approved before launch; it now comes from a reviewed per-run manifest (or
// the original fixed MP4) instead of a compiled constant. Duration stays
// within the existing bounds, so no timing guard changes.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

// Every lab timing bound (110 s source guard, 135 s take, 105 s player
// frames) was set for media up to this length.
export const LAB_MEDIA_MAX_MS = 104000;
export const LAB_MEDIA_MANIFEST_SCHEMA = 'talkqte.fresh-scenario.media.v1';
const MANIFEST_MAX_BYTES = 256 * 1024;
const hex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};

/** True for an approved fictional media descriptor within the lab bounds. */
export function isLabMedia(media) {
  return (
    media?.fictional === true &&
    typeof media.path === 'string' &&
    isAbsolute(media.path) &&
    hex64(media.sha256) &&
    Number.isFinite(media.durationMs) &&
    media.durationMs > 0 &&
    media.durationMs <= LAB_MEDIA_MAX_MS
  );
}

/**
 * Reads a per-run media manifest whose sha256 was approved before launch and
 * returns the media descriptor it pins. Fails closed on any mismatch. The
 * media file itself is hashed again by the player before use.
 */
export function loadLabMediaManifest(manifestPath, { sha256 } = {}) {
  required(
    typeof manifestPath === 'string' &&
      isAbsolute(manifestPath) &&
      hex64(sha256),
  );
  const stat = lstatSync(manifestPath);
  required(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= MANIFEST_MAX_BYTES,
  );
  const raw = readFileSync(manifestPath);
  required(
    raw.length === stat.size &&
      createHash('sha256').update(raw).digest('hex') === sha256,
  );
  const m = parseUniqueLabJson(raw.toString('utf8'));
  const media = m?.media;
  required(
    m?.schema === LAB_MEDIA_MANIFEST_SCHEMA &&
      m.fictional === true &&
      typeof m.scenarioId === 'string' &&
      /^[A-Za-z0-9_.-]{1,96}$/.test(m.scenarioId) &&
      m.verification?.passed === true &&
      m.window?.withinCurrentLabCap === true &&
      typeof media?.path === 'string' &&
      isAbsolute(media.path) &&
      realpathSync(media.path) === media.path &&
      hex64(media.sha256) &&
      Number.isSafeInteger(media.bytes) &&
      media.bytes > 0 &&
      Number.isSafeInteger(media.durationMs) &&
      media.durationMs > 0 &&
      media.durationMs <= LAB_MEDIA_MAX_MS &&
      media.video?.codec === 'h264' &&
      media.audio?.codec === 'aac' &&
      media.audio?.sampleRate === 48000,
  );
  const descriptor = Object.freeze({
    fictional: true,
    path: media.path,
    sha256: media.sha256,
    durationMs: media.durationMs,
    scenarioId: m.scenarioId,
  });
  required(isLabMedia(descriptor));
  return descriptor;
}
