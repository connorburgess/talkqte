# Contributing to TalkQTE

TalkQTE is in early development. Reproducible bug reports, accessibility feedback, documentation improvements, and focused fixes are useful contributions.

## Before starting

Read the [roadmap](ROADMAP.md) and [architecture decision](docs/architecture.md). Open an issue for a substantial feature or architectural change so we can agree on scope. Small fixes can go directly to a PR.

## Run and check the prototype

Use Node.js 22, Rust 1.97.1, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for macOS. Install dependencies with `npm ci`, then run `npm run desktop`. `npm run dev` runs only the browser preview, using a simulated session adapter rather than the Rust backend.

```sh
npm run format:check
npm run test:contributions
npm run build
npx playwright install chromium webkit
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
npm run tauri -- build --debug --bundles app
```

On Linux, Playwright may also need system dependencies: `npx playwright install --with-deps chromium webkit`. The native app currently targets macOS; a browser test on another platform does not establish native support there.

Rust tests cover question expiry, pause, stale responses, saved-question replay, note limits, and the restricted overlay payload. Playwright exercises the notebook in Chromium and WebKit, including export review, keyboard navigation, and a narrow layout with reduced motion. Browser tests do not prove native overlay behavior. Check the actual macOS app when changing native commands, permissions, or windows.

Pull-request checks also require an author-matching sign-off trailer on each contribution commit and reject common tool-attribution credits in commit messages and PR text. These automated checks complement human review; they do not establish a contributor's legal identity, verify contributor-agreement acceptance, or catch every possible credit format.

Use only the bundled fictional demo for public evidence. Test data and notes are memory-only; restarting the app clears them. The local export is the only implemented way to keep notebook content.

## Branch and review workflow

After the initial bootstrap, all changes use a branch and pull request targeting `main`. The owner's branch convention is `cb/<short-change>`; other contributors can use their own prefix.

Keep each PR focused on one outcome. Explain the problem, resulting behavior, and evidence used to verify it. Include fictional before/after screenshots for UI changes. A local successful check is not a claim about GitHub CI.

When responding to a finding, name the finding, explain the fix or reason for leaving it, and link the commit. Reference CI only with the specific run, jobs, and commit. Do not reply to an all-clear or continue a back-and-forth with a reviewer bot.

## Commit and pull-request titles

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for new contribution commits and PR titles:

```text
type(optional-scope): describe the result
```

Use lowercase types and a short, plain-language description. Scope is optional; include it when it helps identify the area, such as `companion`, `capture`, `cues`, or `roadmap`.

| Type       | Use for                                            |
| ---------- | -------------------------------------------------- |
| `feat`     | New or deliberately changed user-facing behavior   |
| `fix`      | Correcting a defect                                |
| `docs`     | Documentation changes                              |
| `refactor` | Restructuring code without changing behavior       |
| `test`     | Test-only changes                                  |
| `chore`    | Repository maintenance that fits none of the above |

Use `build`, `ci`, `perf`, `style`, or `revert` when they describe the change more precisely. `style` means code formatting, not a visual UI change. Mark a breaking change with `!` before the colon and explain the impact and migration in the body.

Examples:

```text
fix(companion): remove the light window border
feat(cues): simplify live cue controls
docs(roadmap): describe progression to broader availability
ci: check contribution metadata
```

Keep each commit coherent and independently reviewable. Include relevant tests with the behavior they verify; separate unrelated documentation or maintenance. Avoid `WIP`, `updates`, and `fix stuff` as final subjects. The body should explain why the change is needed when the subject and diff are insufficient.

Use the same title format for the PR, describing its overall outcome. Its description covers the problem, resulting behavior, and verification; a title prefix does not replace that explanation. Choose the main type when a focused PR also includes supporting tests or documentation.

Apply the convention going forward. Do not rewrite published history just to add prefixes; generated merge commits are exempt. Keep the required human contribution sign-off on every contribution commit. Title prefixes are a documented convention; the existing metadata check enforces sign-offs and attribution rules, not title syntax.

## Sign off your commits

Every contribution commit must include a `Signed-off-by:` line matching its author. By signing off, you confirm that you created the contribution or have the right and any necessary employer authorization to submit it under the applicable contribution terms. Use your real name and an email address you control. A GitHub-provided `noreply` address is welcome for privacy; use the same identity for author and sign-off.

```sh
git commit -s -m "fix(companion): remove the light window border"
```

The sign-off records contribution origin and is different from cryptographically signing a commit. New contributions are distributed under the [Sustainable Use License](LICENSE), subject to any preserved third-party terms, and require the contributor agreement below. A sign-off alone does not accept that agreement. Historical DCO sign-offs remain associated with their original commits; the unchanged [DCO 1.1 text](LICENSES/DCO-1.1.txt) is retained for reference and is no longer the current sign-off policy.

If you forgot the sign-off on your own most recent unshared commit:

```sh
git commit --amend --no-edit -s
```

Do not rewrite someone else's commits or add a certification on their behalf. Coordinate before rewriting a branch that other people use. Your commit identity and sign-off become part of public Git history.

## Contributor agreement

Read the short [Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md). You retain copyright and give Connor Burgess permission to license your contribution under other terms, including commercial terms. This supports the project's free personal/internal-business use and separate commercial licensing. It is not a copyright assignment.

For each PR, every contributor other than the project steward must personally post the following statement in their own PR description or comment, linking the agreement revision they read:

> I have read and agree to the TalkQTE Contributor License Agreement at [link to the agreement revision] for my contributions in this pull request.

Use a GitHub permalink to the agreement at a specific commit, and confirm you have any necessary employer authorization. Do not accept for another contributor. The maintainer must verify acceptance from every contributor before merging and retain the public record. The metadata check only verifies sign-offs; it does not automate this review. The steward does not need to grant rights to themself.

This agreement does not apply retroactively. Do not assume that an earlier DCO sign-off grants commercial relicensing permission. Preserve third-party notices and disclose imported material and its license in the PR.

## Public data and evidence

- Use fictional people, organizations, meeting dialogue, and `example.com` addresses.
- Never upload a real meeting recording or transcript in an issue, PR, screenshot, artifact, or test fixture.
- Reproduce problems in an isolated test profile. Do not run destructive tests against your real meeting notebook.
- Document changes to storage, retention, network access, capture permissions, and export behavior.
- Add tests for meaningful behavior changes and failure cases. Avoid snapshot churn and tests that restate the code.
- Record licenses for dependencies, models, fonts, and bundled assets. The app's license does not replace their terms.

## Authorship and presentation

The human contributor is responsible for their change. Do not add AI co-author trailers, credits, generated-with footers, or session links to commits, PRs, issues, comments, documentation, releases, or app assets. Human contributor sign-offs remain required. Preserve required dependency notices.

## Security and conduct

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## Branch rules

`main` is protected by a repository ruleset: changes arrive through pull requests, the four CI jobs must pass on the pull request's final commit, and the branch cannot be force-pushed or deleted. The loop that merges reviewed pull requests waits for those checks by hand as well; the ruleset makes the same rule hold for anyone.
