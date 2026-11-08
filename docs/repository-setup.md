# Repository setup and review

## Workflow

Bootstrap project instructions, docs, and tooling on `main`. Subsequent work uses feature branches and pull requests. Owner branches begin with `cb/`; titles describe the behavior or outcome. Do not automatically merge feature PRs.

## Checks to establish before the first feature merge

- DCO validation for every contribution commit, matching the human author's identity.
- A no-attribution check for commit metadata and PR title/body, rerun when the PR text changes.
- Secret and private-data scanning, including public fixtures and build artifacts.
- Rust formatting, Clippy, meaningful tests, and a native build on supported targets.
- Frontend formatting/lint, typechecking, build, and behavioral UI checks once the frontend exists.

These checks are planned, not enabled by this document. Add them with the runnable scaffold and configure branch rules after the check names exist. Protect `main` against force pushes and deletion and require the applicable checks. Do not require an impossible self-approval while the project has one maintainer.

## External automated review

Graphide review is deferred while the initial prototype takes shape. Keep automatic reviews off until the maintainer explicitly enables them. Creating a PR does not authorize changing review settings or starting a paid service.

When review is enabled, limit access to selected public repositories and verify Rust/native analysis on an actual PR. Focus on capture lifecycle, bounded buffers, threading, IPC validation, retention, and outbound data paths. Never provide real meeting fixtures or recordings to a review service.

## Handling findings

Name each finding, explain the change or reason for not changing it, and link the commit. Mention CI only with a specific run link, named jobs, and commit. No all-clear replies, and no replies to a bot's reply to our own response.

## Privacy setup

Enable GitHub private vulnerability reporting. Review the owner's Git commit identity before the first public push; use the account's GitHub noreply email where appropriate. Never copy local automation prompts, webhook settings, private logs, or desktop screenshots into this repository.
