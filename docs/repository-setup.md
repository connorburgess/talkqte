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

## Graphide

Graphide Review must be installed or granted access to this repository on GitHub and then enabled in its dashboard. A repository file alone does not enable it. Keep access limited to the repositories the owner selected.

Recommended starting settings:

- Review enabled for TalkQTE.
- One automatic review per PR, then request additional review after substantive fixes when useful.
- Check Rust/native analysis support using an actual PR before relying on it.
- Focus reviews on capture lifecycle, bounded buffers, threading, IPC validation, retention, and outbound data paths.
- No real meeting fixtures or recordings in any review environment.

The published allowance is the first 150 reviews per GitHub App installation, shared by its enabled repositories. It is not a monthly allowance or a fresh allowance per repository. Reviews pause after it is exhausted; do not enable paid services without an explicit decision.

As of initial setup, review enablement has not been confirmed. Sign-in or account-owner action may be required.

Sources: [connection setup](https://graphide.com/docs/connect/), [review settings](https://graphide.com/docs/review/), [free allowance](https://graphide.com/docs/review/free-reviews/).

## Handling findings

Name each finding, explain the change or reason for not changing it, and link the commit. Mention CI only with a specific run link, named jobs, and commit. No all-clear replies, and no replies to a bot's reply to our own response.

## Privacy setup

Enable GitHub private vulnerability reporting. Review the owner's Git commit identity before the first public push; use the account's GitHub noreply email where appropriate. Never copy local automation prompts, webhook settings, private logs, or desktop screenshots into this repository.
