# Frontend guidance and legacy-pattern review

Use Impeccable for design and interaction decisions and [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance) for web-platform guidance. Preserve the quiet companion described in [DESIGN.md](../DESIGN.md). Default to **Baseline Widely available**, as defined by the [official setup guidance](https://developer.chrome.com/docs/modern-web-guidance/get-started#baseline). Check actual supported Tauri webviews and fallbacks before adopting newer APIs; Baseline is not native acceptance.

The existing web surface is `src/` (React/TypeScript and CSS) plus `index.html`. The source scanner needs no browser integration, browser automation, running app, model, capture or account. Native Rust, lab scripts, runtime data, website repositories and generated bundles are outside this scan. Recording and native validation remain separate priorities.

## Reproducible local check

```sh
npm ci --prefix tools/modern-web --ignore-scripts --no-audit --no-fund
npm test --prefix tools/modern-web
node tools/modern-web/scan.mjs > modern-web-report.json
```

The isolated package pins `modern-web-guidance` **1.0.0**, Node.js 22 or later, and its tarball integrity in its own lockfile. This package declares no dependencies or install scripts; parser dependencies and rules are bundled in that tarball. Upgrades require a reviewed version/lockfile change and renewed verification. The app's dependencies are unaffected. Do not run the upstream skill installer or update commands; the recommended upstream installation enables automatic updates.

The wrapper invokes the installed `modern-web-guidance legacy-scan <path> --json` entry point for each fixed frontend target. It disables telemetry and file logging, passes no inherited credentials, Node preload or proxy settings, and enables Node read permissions only for that target and the installed scanner. It grants no filesystem writes, child processes, addons or workers. Without child-process permission the scanner's Git enumeration falls back to its sorted filesystem walk. Node's permission system is a limited guard, not a general sandbox or network firewall; the inspected scan path uses local bundled parsing, with no LLM, paid API or autofix.

Reports contain relative source paths and snippets of public frontend code. Keep local reports untracked; never scan private recordings, notes or credentials. Suggested `retrieveCommand` strings in upstream JSON are data, not commands to execute blindly. For guide lookup use the same installed version with telemetry disabled and review its compatibility advice.

## Outcomes and limits

Verified against the 1.0.0 tarball:

- A successful scan returns exit **0** both with findings and with none. JSON carries `targetDir`, `totalFindings`, grouped `guides`/`rules`/`findings`, and active rule/guide counts. Findings include source locations, snippets and Keep/Drop criteria.
- A missing target returns exit **1** and JSON with `error`, even though `totalFindings` is **0**. Invalid arguments also fail. The wrapper treats nonzero exit, malformed/truncated JSON, an unexpected version or invalid report shape as **error**, never as no findings.
- The wrapper emits one JSON envelope with `status` **findings**, **no-findings** or **error**; only error exits **1**. It bounds each scan to 60 seconds and 4 MiB of output. Identical fixture scans produce identical JSON; no timestamp is added.
- This is a limited static legacy-pattern scan, not a Baseline compliance, correctness, security, performance or accessibility certification. The scanner covers only part of the guidance corpus, excludes documentation/tests by default, limits file size/count, and can skip unreadable or unsupported files. A zero report establishes only no matched patterns in what it scanned.

The separate [advisory workflow](../.github/workflows/modern-web.yml) runs only for frontend/tooling changes, or an explicit manual dispatch. It has `contents: read`, no persisted checkout credentials, no secrets and no deployment step. It saves JSON and wrapper stderr as a seven-day artifact. Raw child stderr is not retained; scanner errors use fixed wrapper diagnostics and the upstream JSON error when available. Findings are advisory. Scanner/setup/test errors remain visible as failed steps and an explicit error summary, with a nonblocking job; absence of a report is an error. The four required checks remain unchanged.

Review each useful finding against the current source and the guide's Keep/Drop criteria. Prioritize a small user-visible regression test and focused fix when recurring evidence warrants it. No bulk remediation or automatic fixes are part of this integration. Human review precedes publication/merge; no website deployment is authorized by a scanner report.
