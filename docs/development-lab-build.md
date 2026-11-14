# Development lab build artifact

The manual **Development lab build artifact** workflow prepares a macOS arm64
debug bundle when local build capacity is insufficient. It is separate from
normal Checks and the release path. It does not launch the app, load a speech
model, run an evaluator, capture content, sign, notarize, release or publish a
product. No signing key or inference credential is supplied to CI.

This workflow is preparation only. It has offline contract tests; a successful
full-feature workflow build and an approved local build receipt remain pending.
No existing default-feature Checks bundle is an eligible lab launch binary.

## Dispatch gate

Do not dispatch until the coordinator approves an exact assembled source commit
after the required backend, Stop and launcher dependencies close. Implementation
or merge approval of this workflow is not dispatch or runtime approval.

Dispatch from the repository's `main` workflow only, with `source_commit` set to
the approved full 40-character lowercase commit SHA. Branch names, tags, short
SHAs, expressions and zero SHAs fail before source checkout. Immediately after source checkout, literal trusted workflow commands require
exact HEAD equality and ancestry from `refs/remotes/origin/main`, before `npm ci`,
tests or any selected-source helper can execute. The helper repeats the identity
and ancestry checks and requires a clean checkout before building. Main ancestry establishes source location; it does not replace the
coordinator's exact-commit approval. The selected commit must already contain the
reviewed helper/tests and assembled native dependencies. There is no arbitrary
command, feature, artifact path or signing input.

The existing pinned macOS/Node/Rust setup is reused. The helper also refuses a
non-arm64/non-macOS host. The sole build uses debug mode, locked dependencies,
`--no-default-features`, Tauri `--no-sign` and exactly:

- `lab-evaluator`
- `local-whisper`
- `native-audio-spike`
- `timing-log`

`TALKQTE_COMMIT` is set to the approved SHA at build time. The deployment setting
remains macOS 14.0. No `claude-cli`, provider selection, runtime consent, permission
change or model download is enabled by this build. Ambient signing, configuration,
compiler-feature overrides and TalkQTE runtime settings fail before compilation.
The linker may embed its ordinary Mach-O ad-hoc metadata; CI performs no
application identity signing. Local Development signing remains required.

## Bounded output and receipt

The fixed output is only `TalkQTE-lab-arm64.zip` and `build-receipt.json`, retained
for one day as a GitHub Actions artifact. It is a development artifact in this
public repository, not a private runtime-data destination. Never put media,
weights, recordings, logs, descriptors, credentials or conversation data in it.

Before archiving, the helper reads only the exact built `TalkQTE.app` path. It
refuses symlinks, hard-linked files, special files, more than 4,096 files, more
than 8,192 total entries, nesting beyond 32 levels or more than 512 MiB of file
contents. The archive must also be at most 512 MiB before upload. These bounds
apply to the produced artifact, not compiler intermediate disk usage. A fresh
output directory is required; only the two named files can be uploaded. Bundle
content/mode hashes must remain unchanged through archive creation.

The `talkqte.lab.ci-build.v1` receipt contains the source SHA, exact ordered feature
list, debug flag, arm64 target, `signing: not-performed`, bundle identity/macOS
minimum, file count/content bytes/tree hash/executable hash, archive name/bytes/hash
and both dependency-lock hashes. It contains no machine paths or runtime input.
A receipt is a build record, not a signing identity, independent source attestation
or approval to launch. Match it to the exact successful workflow run and GitHub
artifact metadata independently; a supplied receipt cannot approve itself.

## Local verification and Development signing

The native owner must complete these checks before requesting launch approval:

1. Check the workflow source, selected commit, run/jobs and GitHub artifact
   identity/digest against the coordinator's approval. Check available capacity
   for the archive, extraction and signing; downloading this artifact requires
   no local Rust compilation. Keep it in new private external storage.
2. Download only the artifact from that successful run. Require exactly its two
   named files. Use the approved source checkout's helper to check the receipt
   schema, SHA/features/bounds and actual archive hash/size:

   ```sh
   LAB_ARTIFACT_DIRECTORY=/absolute/private/ci-artifact \
     node scripts/lab-build-artifact.mjs verify <approved-full-commit-sha>
   ```

   The artifact directory must be canonical, without symlink aliases. This check
   does not extract, sign or launch anything and does not inspect ZIP entries.
3. Before extraction, inspect the archive directory for exactly one
   `TalkQTE.app` root, no absolute/traversal paths, symlinks, special entries or
   unexpected data. Use a bounded extractor into a new private directory. Compare
   the extracted tree hash/file count/bytes, executable hash and lockfile hashes
   with the receipt and approved source. Refuse mismatch or uncertainty.
4. Inspect `Info.plist` for `com.talkqte.desktop`, executable `talkqte` and macOS
   14.0 minimum. Inspect Mach-O architecture, deployment target and dependent
   libraries; a declared receipt target alone does not prove compatibility.
   Review embedded notices and entitlements. Do not run the binary as a check.
5. Only under the approved local signing plan, sign with **TalkQTE Development**,
   preserve the configured entitlements and existing grants, and verify strict/deep
   signature, sole authority and pinned designated requirement. Do not reset
   permissions, change signing identity or substitute an ad-hoc identity. Stop on
   any new owner-action prompt.
6. Hash the signed executable after signing. Freeze a separate private
   `talkqte.lab.build.v1` launch manifest and coordinator-approved
   manifest-hash/executable-hash/commit tuple. The CI receipt has a different schema
   and cannot be passed to the launcher as approval. The launcher must repeat
   bundle/signature/plist/hash checks immediately before its sole owned spawn.

The next acceptance check is a reviewed build-only dispatch on approved assembled
source, followed by a verified local signed manifest. Exact fictional playback
controls/start acknowledgement, permission-prompt observation, bounded Stop/release,
provider cleanup, calibrated timing, actual transcription/cue-or-silence and visible
companion paint still need their separately approved integrated run. Neither an
artifact nor offline tests establish that runtime evidence.
