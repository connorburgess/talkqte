import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const packageRoot = resolve(here, 'node_modules/modern-web-guidance');
const cli = resolve(packageRoot, 'skills/modern-web-guidance/modern-web.mjs');
export const targets = ['src', 'index.html'];

// A JSON error can have zero findings. Neither zero nor exit 0 alone means clean.
export function classify(result, target) {
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { target, status: 'error', reason: 'invalid-json' };
  }
  if (result.error || result.status !== 0 || report?.error) {
    return { target, status: 'error', reason: 'scanner-failed', report };
  }
  if (
    !report ||
    typeof report !== 'object' ||
    report.targetDir !== target ||
    !Number.isInteger(report.totalFindings) ||
    report.totalFindings < 0 ||
    !Array.isArray(report.guides) ||
    !Number.isInteger(report.activeRuleCount) ||
    report.activeRuleCount <= 0 ||
    !Number.isInteger(report.activeGuideCount) ||
    report.activeGuideCount <= 0 ||
    report.guides.reduce((sum, guide) => sum + guide.count, 0) !==
      report.totalFindings
  ) {
    return { target, status: 'error', reason: 'invalid-report', report };
  }
  return {
    target,
    status: report.totalFindings === 0 ? 'no-findings' : 'findings',
    report,
  };
}

export function scan(target, { cwd = root } = {}) {
  const targetPath = realpathSync(resolve(cwd, target));
  return classify(
    spawnSync(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${packageRoot}`,
        `--allow-fs-read=${targetPath}`,
        cli,
        'legacy-scan',
        target,
        '--json',
      ],
      {
        cwd,
        // No inherited model credentials, Node preload flags, logging or proxy settings.
        env: {
          DISABLE_TELEMETRY: '1',
          ENABLE_FILE_LOGGING: 'false',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
    target,
  );
}

export function run() {
  const reports = [];
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    if (pkg.version !== '1.0.0') throw new Error('unexpected scanner version');
    for (const target of targets) reports.push(scan(target));
  } catch {
    reports.push({ status: 'error', reason: 'scanner-or-target-unavailable' });
  }
  const status = reports.some((item) => item.status === 'error')
    ? 'error'
    : reports.some((item) => item.status === 'findings')
      ? 'findings'
      : 'no-findings';
  return { scanner: 'modern-web-guidance', version: '1.0.0', status, reports };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'error') {
    process.stderr.write(
      'Modern Web Guidance scanner error; this is not a clean scan.\n',
    );
    process.exitCode = 1;
  }
}
