// Approved fictional media for a lab take. The trust anchor is a sha256
// approved before launch; it now comes from a reviewed per-run manifest (or
// the original fixed MP4) instead of a compiled constant. Duration stays
// within the existing bounds, so no timing guard changes.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

// Every lab timing bound (110 s source guard, 135 s take, 105 s player
// frames) was set for media up to this length. Two looser ceilings remain
// behind it: the player controller's 105000 ms duration checks and the Swift
// player's compiled 105 s decode limit. The player also refuses a file whose
// measured asset duration differs from the approved one by more than 100 ms.
export const LAB_MEDIA_MAX_MS = 104000;
export const LAB_MEDIA_MANIFEST_SCHEMA = 'talkqte.fresh-scenario.media.v1';
const MANIFEST_MAX_BYTES = 256 * 1024;
// The original fixed fictional meeting, approved by its compiled hash.
export const LAB_FIXED_MEDIA_SHA256 =
  '1faf1c404249bed069065f51262abfce6956fa8a31f237e68bb6e9d06cb893e2';
export const LAB_FIXED_MEDIA_DURATION_MS = 102480;
// Descriptors created only by this module: from an approved manifest, from
// the fixed media's compiled hash, or derived from one of those. A hand-built
// object with the right fields and a matching file hash is not approved.
const approved = new WeakSet();
// Bound once at load, so later changes to WeakSet.prototype cannot widen
// what counts as approved.
const isApproved = WeakSet.prototype.has.bind(approved);
const addApproved = WeakSet.prototype.add.bind(approved);
const approve = (descriptor) => {
  const frozen = Object.freeze(descriptor);
  addApproved(frozen);
  return frozen;
};
// The player hashes the media and then opens it again, so approved files
// must sit in owner-only directories nobody else can swap them in. Only the
// immediate directory is checked, at approval time; this closes the gap to
// other users but not to the owner's own processes.
const ownerOnly = (dir) => {
  const s = lstatSync(dir);
  return (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    (s.mode & 0o077) === 0 &&
    s.uid === process.getuid?.()
  );
};
const sha256OfFile = (path, max) => {
  const st = lstatSync(path);
  required(
    st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= max,
  );
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};
const hex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};

/** True only for a descriptor this module approved, within the lab bounds. */
export function isLabMedia(media) {
  return (
    isApproved(media) &&
    media.fictional === true &&
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
  required(ownerOnly(dirname(manifestPath)));
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
      ownerOnly(dirname(media.path)) &&
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
  const descriptor = approve({
    fictional: true,
    path: media.path,
    sha256: media.sha256,
    durationMs: media.durationMs,
    scenarioId: m.scenarioId,
  });
  required(isLabMedia(descriptor));
  return descriptor;
}

/**
 * The original fixed fictional meeting at `path`. The file must hash to the
 * compiled fixed sha256 and sit in an owner-only directory, like per-run media.
 */
export function fixedLabMedia(path) {
  required(
    typeof path === 'string' &&
      isAbsolute(path) &&
      realpathSync(path) === path &&
      ownerOnly(dirname(path)) &&
      sha256OfFile(path, 256 * 1024 * 1024) === LAB_FIXED_MEDIA_SHA256,
  );
  return approve({
    fictional: true,
    path,
    sha256: LAB_FIXED_MEDIA_SHA256,
    durationMs: LAB_FIXED_MEDIA_DURATION_MS,
    scenarioId: 'fixed-meeting-102480',
  });
}

/**
 * Labels an approved descriptor as neutral calibration media for the
 * adaptive playback path. The result stays approved because it is derived
 * from an approved descriptor and only adds a bounded display label.
 */
export function labelLabBootstrapMedia(media, displayLabel) {
  required(
    isLabMedia(media) &&
      typeof displayLabel === 'string' &&
      displayLabel.trim().length > 0 &&
      displayLabel.length <= 120 &&
      !/[\u0000-\u001f\u007f]/.test(displayLabel),
  );
  return approve({ ...media, purpose: 'neutral-calibration', displayLabel });
}
