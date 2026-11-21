// Approved fictional media for tests, created through the real manifest
// loader: a synthetic manifest and placeholder bytes in a private temporary
// directory. The harmless player fixture never reads the bytes.
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLabMediaManifest } from '../cue-lab-media.mjs';

const directories = [];
process.once('exit', () => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function fictionalTestMedia({ durationMs = 102480 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tq-test-media-')));
  directories.push(dir);
  const path = join(dir, 'fictional.mp4');
  const bytes = Buffer.from(`fictional placeholder ${dir}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  const raw = JSON.stringify({
    schema: 'talkqte.fresh-scenario.media.v1',
    fictional: true,
    scenarioId: 'fs-fictional-test',
    media: {
      path,
      sha256: sha(bytes),
      bytes: bytes.length,
      durationMs,
      video: { codec: 'h264' },
      audio: { codec: 'aac', sampleRate: 48000 },
    },
    window: { withinCurrentLabCap: true },
    verification: { passed: true },
  });
  const manifest = join(dir, 'MANIFEST.json');
  writeFileSync(manifest, raw, { mode: 0o600 });
  return loadLabMediaManifest(manifest, { sha256: sha(raw) });
}
