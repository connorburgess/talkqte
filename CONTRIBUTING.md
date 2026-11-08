# Contributing to TalkQTE

TalkQTE is in early development. Reproducible bug reports, accessibility feedback, documentation improvements, and focused fixes are useful contributions.

## Before starting

Read the [roadmap](ROADMAP.md) and [architecture decision](docs/architecture.md). Open an issue for a substantial feature or architectural change so we can agree on scope. Small fixes can go directly to a PR.

The application has not been scaffolded yet. Build and test commands will be documented alongside the first runnable implementation; there are no implied passing application checks at this stage.

## Branch and review workflow

After the initial bootstrap, all changes use a branch and pull request targeting `main`. The owner's branch convention is `cb/<short-change>`; other contributors can use their own prefix.

Keep each PR focused on one outcome. Explain the problem, resulting behavior, and evidence used to verify it. Include fictional before/after screenshots for UI changes. A local successful check is not a claim about GitHub CI.

When responding to a finding, name the finding, explain the fix or reason for leaving it, and link the commit. Reference CI only with the specific run, jobs, and commit. Do not reply to an all-clear or continue a back-and-forth with a reviewer bot.

## Sign off your commits

Every contribution commit must include a `Signed-off-by:` line certifying the [Developer Certificate of Origin 1.1](DCO). Use your real name and an email address you control. A GitHub-provided `noreply` address is welcome for privacy; use the same identity for author and sign-off.

```sh
git commit -s -m "Keep a saved question after the prompt expires"
```

The sign-off records your right to submit the contribution under its license. It is different from cryptographically signing a commit. There is no separate CLA. Contributions are accepted under [Apache-2.0](LICENSE).

If you forgot the sign-off on your own most recent unshared commit:

```sh
git commit --amend --no-edit -s
```

Do not rewrite someone else's commits or add a certification on their behalf. Coordinate before rewriting a branch that other people use. Your commit identity and sign-off become part of public Git history.

## Public data and evidence

- Use fictional people, organizations, meeting dialogue, and `example.com` addresses.
- Never upload a real meeting recording or transcript in an issue, PR, screenshot, artifact, or test fixture.
- Reproduce problems in an isolated test profile. Do not run destructive tests against your real meeting notebook.
- Document changes to storage, retention, network access, capture permissions, and export behavior.
- Add tests for meaningful behavior changes and failure cases. Avoid snapshot churn and tests that restate the code.
- Record licenses for dependencies, models, fonts, and bundled assets. The app's license does not replace their terms.

## Authorship and presentation

The human contributor is responsible for their change. Do not add AI co-author trailers, credits, generated-with footers, or session links to commits, PRs, issues, comments, documentation, releases, or app assets. Human DCO sign-offs remain required. Preserve required dependency notices.

## Security and conduct

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.
