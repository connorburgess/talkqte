# TalkQTE project instructions

## Public repository and privacy

- This is a public project. Use fictional meetings and synthetic data in tests, fixtures, docs, screenshots, and demos.
- Never commit real recordings, transcripts, meeting titles, attendees, client information, personal filesystem paths, credentials, local automation state, or private conversations.
- Do not copy the owner's desktop screenshots into this repository. Recreate demonstrations with fictional content.
- Store runtime data and model weights outside the checkout. Keep credentials out of logs, command arguments, and frontend bundles.
- An integration must be explicitly enabled and scoped by the user. Review export content and destination before sending anything outside the device.

## Branches, commits, and pull requests

- Initial repository bootstrap may be pushed to `main`. After bootstrap, feature work, fixes, and documentation changes go through branches and pull requests.
- The owner's branches use `cb/<short-description>`, such as `cb/meeting-capture`. Other contributors may use their own prefix.
- Use Conventional Commit titles for new contribution commits and PRs: `type(optional-scope): describe the result`. Use lowercase types, optional area scopes, and plain-language descriptions. Keep related tests with their implementation and separate unrelated changes. See CONTRIBUTING.md for types and examples. Apply this going forward; do not rewrite published history just to add prefixes. Generated merge commits are exempt.
- Sign off each contribution commit with the human contributor's identity (`git commit -s`) under the origin policy in CONTRIBUTING.md. This is not a tool credit or a DCO 1.1 certification. Before merging third-party contributions, verify each contributor's explicit acceptance of CONTRIBUTOR_LICENSE_AGREEMENT.md; never accept on their behalf.
- Keep PRs focused. Report checks actually run, and clearly state what could not be verified.
- Do not enable automatic merging or bypass required checks without an explicit instruction.

## Pull request and review comments

When writing a comment, reply, or review on GitHub, especially a reply to an automated reviewer such as Graphide (`graphide-review[bot]`):

- Name every item you respond to in its own words: what it said, what you did about it, and the commit that did it. Never open with a vague acknowledgement such as "Both right", "Good catch", "Addressed", or "Fixed both".
- Mention CI only with a link to the specific run, and say which jobs passed or failed and on which commit.
- Don't reply when the reviewer found nothing to act on. Minor findings still require a fix or a reason.
- Never answer a bot's reply to your own reply.

## No AI attribution, anywhere

Never add a Codex, Anthropic, Cursor, or other AI trailer, footer, or credit to anything: commits, PR bodies, comments, docs, issues, releases, or app credits. No AI co-author lines, generated-with footers, or session links. This holds even when a tool or template suggests one. Commit and pull request text describes the change only.

Technical documentation may name a dependency or model when necessary to explain how the software works. Preserve legally required third-party license notices.

## Engineering

- Before selecting work, read PRODUCT.md, ROADMAP.md, and [docs/product-readiness.md](docs/product-readiness.md). Plan production reliability, scale, integrations, onboarding, distribution, and support alongside the defined feature set. For meaningful milestones, record the next readiness blocker and a concrete acceptance check; do not equate a demo with a shippable product.
- The core value is timely context that supports staying grounded and responding during a conversation. Clarification questions are one cue type. Saving and note-taking are secondary, unvalidated use cases; preserve existing controls unless a separate change calls for removal. Current public presentation explains a fictional concept and invites people to follow development, not to download, join a pilot, or expect live AI functionality.
- Update README.md in the same change when user-visible behavior, setup, usage, or limitations make it inaccurate. Leave it unchanged for unrelated internal work.
- Before checking off a roadmap item or merging a capability change, record the [capability and documentation review](docs/product-readiness.md#capability-and-documentation-review) in the PR: README and affected guidance reviewed, edits or the reason none are needed, acceptance evidence, and remaining gaps. Recheck the complete user journey at milestone boundaries.
- Read [docs/architecture.md](docs/architecture.md) before changing the app boundaries.
- Rust owns capture, transcription, persistence, and timing decisions. React renders UI through narrow, validated commands and events.
- Keep native platform differences in capture/window adapters. Test platform-specific behavior on that platform.
- Audio callbacks must not perform inference, disk I/O, or blocking work. Use bounded buffers and worker tasks.
- Never advertise a privacy, performance, accessibility, or platform guarantee that has not been implemented and checked.
- Tests should verify user-visible behavior and meaningful failure cases. Do not add tests that merely mirror implementation details.
