# Repository setup and review

## Workflow

Bootstrap project instructions, docs, and tooling on `main`. Subsequent work uses feature branches and pull requests. Owner branches begin with `cb/`; titles describe the behavior or outcome. Do not automatically merge feature PRs.

## Automated checks

The [Checks workflow](../.github/workflows/checks.yml) runs on pull requests and updates to `main`, with read-only repository permissions and pinned action revisions. It defines:

- **Contribution metadata:** every PR commit needs a sign-off trailer matching its author. Common tool-attribution credits in commits and PR text are rejected, including after PR text edits. The check does not verify a human's legal identity or acceptance of the contributor agreement; the maintainer must review each contributor's acceptance before merging.
- **Frontend and browser behavior:** contribution-check and release pre-flight regression tests, formatting, TypeScript/build, and Playwright checks in Chromium and WebKit.
- **macOS Rust and desktop build:** Rust formatting, unit tests, Clippy with warnings denied, and an unsigned development app build using the pinned Rust toolchain, a check that the committed [third-party notices](release-path.md#third-party-notices) match the dependencies, and the offline [release pre-flight](release-path.md#pre-flight-script) on that bundle. The workflow holds no signing secret and publishes nothing.

Native tests currently exercise the engine; the app build is not an automated interactive window test. A successful browser run does not establish macOS focus or screen-sharing behavior.

Dedicated secret scanning and branch-rule enforcement remain to be configured. Public fixtures and build artifacts still require manual privacy review. Once the check names exist, protect `main` against force pushes and deletion and require the applicable checks. Do not require an impossible self-approval while the project has one maintainer.

## External automated review

Graphide review is deferred while the initial prototype takes shape. Keep automatic reviews off until the maintainer explicitly enables them. Creating a PR does not authorize changing review settings or starting a paid service.

When review is enabled, limit access to selected public repositories and verify Rust/native analysis on an actual PR. Focus on capture lifecycle, bounded buffers, threading, IPC validation, retention, and outbound data paths. Never provide real meeting fixtures or recordings to a review service.

## Handling findings

Name each finding, explain the change or reason for not changing it, and link the commit. Mention CI only with a specific run link, named jobs, and commit. No all-clear replies, and no replies to a bot's reply to our own response.

## Privacy setup

Enable GitHub private vulnerability reporting. Review the owner's Git commit identity before the first public push; use the account's GitHub noreply email where appropriate. Never copy local automation prompts, webhook settings, private logs, or desktop screenshots into this repository.
