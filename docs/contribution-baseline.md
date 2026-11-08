# Contribution baseline

Reviewed public contribution documents on 2026-11-08. These projects inform TalkQTE's practices; their private automation state and project-specific operational requirements are not part of this repository.

| Project | Practice to adapt |
| --- | --- |
| [sessionpipe](https://github.com/spacesheep-dev/sessionpipe/blob/main/CONTRIBUTING.md) | DCO 1.1, focused PRs, evidence for behavior changes, explicit privacy invariants |
| [sessionpipe-gui](https://github.com/spacesheep-dev/sessionpipe-gui/blob/main/CONTRIBUTING.md) | GitHub noreply addresses for sign-offs, synthetic demos and screenshots, isolated test state |
| [sessionpipe-gui-themes](https://github.com/spacesheep-dev/sessionpipe-gui-themes/blob/main/CONTRIBUTING.md) | Reduced-motion support, explicit third-party notices, fictional public fixtures |
| [Blitz](https://github.com/DioxusLabs/blitz/blob/main/CONTRIBUTING.MD) | Clear native prerequisites and dependency-license checks |
| [herdr-app](https://github.com/herdrdev/herdr-app/blob/master/CONTRIBUTING.md) | Focused native platform boundaries and testing on the affected operating system |
| [herdr-core](https://github.com/herdrdev/herdr-core/blob/master/CONTRIBUTING.md) | Isolated runtime tests, a small shared platform interface, distribution notices |
| [Whiteboard](https://github.com/devdotfast/whiteboard/blob/main/CONTRIBUTING.md) | Plain-language PRs, tests of behavior instead of implementation, explicit storage/privacy changes |
| [Durable Actors](https://github.com/TerseAI/durable-actors/blob/main/CONTRIBUTING.md) | Reproducible validation commands, matching docs for API changes, accurate release notes |
| [smolvm](https://github.com/smol-machines/smolvm/blob/main/.github/workflows/no-ai-attribution.yml) | Automated rejection of AI attribution in commit metadata and PR text |

## TalkQTE choices

- Sustainable Use License and a short contributor agreement for new work, with human origin sign-offs. Earlier Apache-2.0 grants and DCO records remain intact; see [licensing](../LICENSING.md).
- Initial bootstrap on `main`, then branches and PRs. Owner branches use `cb/`.
- Tests and demos use fictional meetings and isolated profiles.
- Required checks should cover contribution sign-offs, attribution, private-data/secret scanning, Rust and frontend validation, and relevant app behavior. Contributor-agreement acceptance is a separate manual review before merging.
- Graphide is a review aid. Its comments do not replace deterministic checks or maintainer review.
- Keep the contributor process small. A prototype does not need another project's ticket system, infrastructure matrix, release branches, or coverage percentage copied wholesale.
