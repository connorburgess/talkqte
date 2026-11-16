import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  LAB_MEDIA_MAX_MS,
  isLabMedia,
  loadLabMediaManifest,
} from './cue-lab-media.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A synthetic fictional manifest in a private temporary directory; the media
// file is placeholder bytes, never a real recording.
function scenario(overrides = {}, mediaOverrides = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tq-media-')));
  const mediaPath = join(dir, 'scenario.mp4');
  const bytes = Buffer.from('fictional placeholder media bytes');
  writeFileSync(mediaPath, bytes);
  const manifest = {
    schema: 'talkqte.fresh-scenario.media.v1',
    fictional: true,
    scenarioId: 'fs-fictional-01',
    media: {
      path: mediaPath,
      sha256: sha(bytes),
      bytes: bytes.length,
      durationMs: 100577,
      video: { codec: 'h264' },
      audio: { codec: 'aac', sampleRate: 48000, channels: 1 },
      ...mediaOverrides,
    },
    window: { withinCurrentLabCap: true },
    verification: { passed: true },
    ...overrides,
  };
  const raw = JSON.stringify(manifest);
  const manifestPath = join(dir, 'MANIFEST.json');
  writeFileSync(manifestPath, raw);
  return {
    dir,
    manifestPath,
    sha256: sha(raw),
    mediaSha: sha(bytes),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('an approved manifest yields exactly the media it pins', () => {
  const s = scenario();
  try {
    const media = loadLabMediaManifest(s.manifestPath, { sha256: s.sha256 });
    assert.deepEqual(
      { ...media },
      {
        fictional: true,
        path: join(s.dir, 'scenario.mp4'),
        sha256: s.mediaSha,
        durationMs: 100577,
        scenarioId: 'fs-fictional-01',
      },
    );
    assert.equal(Object.isFrozen(media), true);
    assert.equal(isLabMedia(media), true);
  } finally {
    s.cleanup();
  }
});

test('a manifest that differs from what was approved, or fails a lab rule, is refused', () => {
  const cases = [
    [{}, {}, (s) => 'f'.repeat(64)],
    [{ fictional: false }, {}],
    [{ verification: { passed: false } }, {}],
    [{ window: { withinCurrentLabCap: false } }, {}],
    [{ schema: 'talkqte.other.v1' }, {}],
    [{}, { durationMs: LAB_MEDIA_MAX_MS + 1 }],
    [{}, { video: { codec: 'hevc' } }],
    [{}, { audio: { codec: 'aac', sampleRate: 44100 } }],
    [{}, { sha256: 'not-a-hash' }],
    [{}, { path: 'relative.mp4' }],
  ];
  for (const [over, mediaOver, approved] of cases) {
    const s = scenario(over, mediaOver);
    try {
      assert.throws(
        () =>
          loadLabMediaManifest(s.manifestPath, {
            sha256: approved ? approved(s) : s.sha256,
          }),
        { category: 'protocol' },
      );
    } finally {
      s.cleanup();
    }
  }
});

test('a symlinked manifest or a symlinked media path is refused', () => {
  const s = scenario();
  try {
    const link = join(s.dir, 'linked.json');
    symlinkSync(s.manifestPath, link);
    assert.throws(() => loadLabMediaManifest(link, { sha256: s.sha256 }));
  } finally {
    s.cleanup();
  }
  const t = scenario();
  try {
    const linkedMedia = join(t.dir, 'linked.mp4');
    symlinkSync(join(t.dir, 'scenario.mp4'), linkedMedia);
    const u = scenario({}, { path: linkedMedia });
    try {
      assert.throws(() =>
        loadLabMediaManifest(u.manifestPath, { sha256: u.sha256 }),
      );
    } finally {
      u.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

// Opt-in check against a real generated scenario kept outside the checkout.
// Set TALKQTE_LAB_MEDIA_MANIFEST and TALKQTE_LAB_MEDIA_MANIFEST_SHA256.
test(
  'an actual generated scenario manifest loads within the lab bounds',
  {
    skip:
      !process.env.TALKQTE_LAB_MEDIA_MANIFEST ||
      !process.env.TALKQTE_LAB_MEDIA_MANIFEST_SHA256,
  },
  () => {
    const media = loadLabMediaManifest(process.env.TALKQTE_LAB_MEDIA_MANIFEST, {
      sha256: process.env.TALKQTE_LAB_MEDIA_MANIFEST_SHA256,
    });
    assert.equal(isLabMedia(media), true);
    assert.ok(media.durationMs <= LAB_MEDIA_MAX_MS);
  },
);

test('a manifest or media directory that others can write or read is refused', () => {
  const s = scenario();
  try {
    chmodSync(s.dir, 0o755);
    assert.throws(
      () => loadLabMediaManifest(s.manifestPath, { sha256: s.sha256 }),
      { category: 'protocol' },
    );
  } finally {
    chmodSync(s.dir, 0o700);
    s.cleanup();
  }
});
