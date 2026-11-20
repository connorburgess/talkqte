// Pure-memory Swift entrypoint only: never the capture helper's main.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'refreshed window identity rejects a reused ID with a foreign or missing owner',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'tq-window-identity-'));
    try {
      const binary = join(directory, 'window-identity-fixture-not-capture');
      execFileSync(
        '/usr/bin/swiftc',
        [
          '-target',
          'arm64-apple-macos14.0',
          '-warnings-as-errors',
          '-parse-as-library',
          '-D',
          'LAB_WINDOW_IDENTITY_TESTS',
          fileURLToPath(new URL('./lab-window-capture.swift', import.meta.url)),
          '-framework',
          'ScreenCaptureKit',
          '-framework',
          'AVFoundation',
          '-framework',
          'CoreMedia',
          '-framework',
          'CoreGraphics',
          '-framework',
          'CoreImage',
          '-o',
          binary,
        ],
        { timeout: 60000, maxBuffer: 16384 },
      );
      assert.deepEqual(
        JSON.parse(
          execFileSync(binary, [], {
            encoding: 'utf8',
            timeout: 2000,
            maxBuffer: 1024,
          }),
        ),
        { checks: 9, passed: true },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
