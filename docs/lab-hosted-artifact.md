# Unsigned hosted lab artifact preparation

The manual `Checks` input `lab_native_sha` confirms the single workflow-owned reviewed native commit
`5a817dbec89e80b64a6114305018ce50c74d8e63` for an unsigned debug arm64 lab bundle.
Any other nonempty input fails before checkout. The executable checkout, build
and provenance use trusted literal pins, never the input value. Changing the
native source requires an ordinary reviewed workflow change; this is not an
arbitrary-SHA build service.

This literal pin identifies a historical reviewed native source snapshot, not
current main or the corrected reconnect/history native source and public JS
package pairing. The workflow does not establish acceptance of that later
combination. A later native target requires a separate ordinary reviewed pin
change with exact source, feature tuple and validation evidence; no later target
is selected here. Existing runtime packages remain unchanged.

Automatic Node package-manager caching is explicitly
disabled only in the artifact job. Empty input preserves normal manual checks;
push and pull-request checks never build this artifact. The nonempty manual path
runs only the isolated artifact job, with read-only repository permission, no
signing secret and no application, player, capture or provider execution.
This workflow is preparation, not a release or permission to process anything.

The workflow ref and native source SHA are separate pins. Dispatch the reviewed
workflow ref through the existing `checks.yml` workflow ID only after the exact
native source review and focused workflow security gates pass. The isolated job
executes the required native validation before it may produce an accepted app. A new standalone workflow cannot
be assumed dispatchable before it exists on the default branch. Use no moving
branch as the native input, no synthetic pull-request merge SHA, and no automated
retry. Record the workflow commit, native commit, run/attempt/job, artifact ID and
API digest before downloading. The artifact job must show a thin arm64 binary,
macOS minimum 14.0, the exact embedded source commit and the locked debug feature
recipe. Runner architecture, toolchain/Xcode versions and hashes are recorded;
Rust version validation and verbose provenance query run from the native source
checkout, using the same source-selected toolchain as the build.
A hosted rebuild is not expected to be byte-identical to a previous local build.

The lab features are `cloud-transcription,lab-evaluator,native-audio-spike,timing-log`,
with `--locked --no-default-features`, no `claude-cli`, and no signing identity.
The source checkout remains clean and the workflow's helper comes from the
separately recorded workflow checkout. Only the repository-built app, relative
inventory, public build provenance and synthetic native validation logs are
uploaded, for three days. Never add
private media, notes, account information or local evidence to this artifact.
The archive removes owner names/IDs and filesystem metadata while preserving
relative paths and modes. The observed app layout is ASCII and link-free;
only ASCII USTAR regular files/directories are accepted. Links, PAX/GNU metadata,
Unicode paths and case aliases (including implicit ancestors) stop artifact
acceptance; they are never renamed, stripped or silently dropped. A future
bundle needing such entries requires a separately reviewed archive contract. Artifact upload/digest support is
[documented by GitHub](https://docs.github.com/en/actions/tutorials/store-and-share-data).

## Combined native validation gate

The artifact job uses one isolated source checkout and target directory for locked
macOS arm64 default tests/Clippy and no-default-feature tests/Clippy with exactly
`cloud-transcription,lab-evaluator,native-audio-spike,timing-log`. Rustfmt also
checks the source. Each shell pipeline uses `pipefail`; a failed command prevents
build/pack. Tests use two harness threads. The 60-minute artifact-only limit
covers both validation matrices and the unsigned debug build; normal job limits
and public required checks are unchanged.

Before build, `validate-native` requires positive passed-test summaries and each
named attestation codec, Engine/Link/Worker lifecycle, generated-production-ACL
IPC, local-path/FIFO reader and readiness test to report `ok`. The runtime matrix
additionally requires the owned-player admission and startup diagnostics cases.
Ignored tests or a zero-test run do not satisfy these requirements. Count-UI
configuration assertions are inside the three attested lifecycle tests. Clippy
must finish successfully in both matrices. These are substituted OS/transport
fixtures, not native UI consent, live capture, provider or usefulness proof.

Four fixed UTF-8 logs are bounded at 16 MiB each before parsing. `pack` independently
revalidates them and embeds their hashes, byte counts, source/workflow identity,
required test names and exact feature tuple in `provenance.json.nativeValidation`.
A separate `native-validation-SHA-attempt` Actions artifact retains those logs and
the report for three days, including partial failure evidence. Missing logs on a
failed job do not turn that failure into success. The app artifact retains its
existing exact three-member outer ZIP contract; extraction rules are unchanged.
Local acceptance must retrieve the same run/attempt validation artifact, compare
all four log hashes to the digest-verified app provenance and independently check
the named test evidence. An upload alone is not proof of executed tests.

## Local acceptance before any signing

No command here compiles Rust. Download only the approved run/artifact into a new
owner-only private directory with sufficient free space. Preserve the disk floor
and all older evidence; do not clean caches. Inspect the outer Actions ZIP before
extraction: permit only `TalkQTE-unsigned.tar.gz`, `inventory.json` and
`provenance.json`, one of each, no absolute/traversing/duplicate/symlink entries,
with expected byte limits. Verify its SHA256 against the separately recorded
Actions API artifact digest. The API digest binds the outer artifact; it is not
the inner archive's hash. Do not trust a matching hash stated only by an
untrusted file inside the same download. Bind the provenance source/workflow
pins to the independently approved run and record all three downloaded hashes.

Inspect provenance and pin `archiveSha256` from that digest-verified artifact.
Use the helper's `verify-download` command for that outer ZIP validation into a
nonexistent owner-only directory, with the independently recorded API digest.
Then the reviewed helper can extract the inner app into a different nonexistent
private destination:

```sh
python3 scripts/lab-hosted-artifact.py verify-download \
  --archive "$LAB_ACTIONS_ZIP" --sha256 "$LAB_ACTIONS_API_DIGEST" \
  --destination "$LAB_NEW_DOWNLOAD"
python3 scripts/lab-hosted-artifact.py extract \
  --archive "$LAB_ARCHIVE" --sha256 "$LAB_ARCHIVE_SHA256" \
  --destination "$LAB_NEW_DESTINATION"
python3 scripts/lab-hosted-artifact.py verify-extracted \
  --app "$LAB_NEW_APP" --provenance "$LAB_PROVENANCE" \
  --inventory "$LAB_INVENTORY" --sha "$LAB_NATIVE_SHA" \
  --workflow-sha "$LAB_WORKFLOW_SHA"
```

Extraction refuses unsafe members before creating output and never overwrites a
destination. It first streams gzip in at most 64 KiB chunks into a bounded
anonymous temporary file: at most 512 MiB TOTAL decoded tar bytes, including
metadata and padding, under the 256 MiB compressed cap. No tar metadata parser
runs before that whole-stream bound passes. A fixed 512-byte header scan then
rejects PAX/GNU/extensions/links before `tarfile` parses members, with at most
20,000 headers/entries and an independent logical-content bound. ASCII-only
path components are checked case-insensitively for aliases across members and
implicit ancestors before writes. The exact case-insensitive macOS escape
reproduction and small compressed oversized metadata cases are offline tests.
Verification compares every relative entry/mode/hash and embedded source.
Independently inspect `file`, `lipo -archs`, `xcrun vtool -show-build` and
Info.plist: require thin arm64, bundle identifier `com.talkqte.desktop` and minimum
macOS 14.0. Inspect all resource paths and notices. Do not execute the app.
A missing, expired, mismatched or unexpected artifact stops acceptance.

## Separately authorized local development signing

Only after artifact acceptance and coordinator signing clearance, copy the new
app into a unique artifact directory. Verify the selected source's committed
`src-tauri/Entitlements.plist` SHA256 is
`d70ae7a3f925e53536fe56d205e4bab9bc1df03495738bf8dfdb6cb6dbb53c7d`:
its only key is `com.apple.security.device.audio-input=true`. Recover that file
from the approved source object; never substitute an unchecked downloaded plist.

The established command uses the existing local development identity. Obtain the
exact identity fingerprint and requirement from the private reviewed signing
packet, not from artifact metadata:

```sh
codesign --force --sign "$LAB_APPROVED_IDENTITY_SHA1" \
  --timestamp=none --identifier com.talkqte.desktop \
  --entitlements "$LAB_APPROVED_ENTITLEMENTS" "$LAB_NEW_APP"
codesign --verify --deep --strict --verbose=2 \
  -R "$LAB_APPROVED_REQUIREMENT" \
  "$LAB_NEW_APP"
```

No `--deep` signing, hardened runtime, keychain override, preserved metadata,
trust change, notarization or distribution identity is added. Independently
compare designated requirement, identifier, flags `0x0`, no TeamIdentifier and
embedded audio-input-only entitlement to the established local recipe. Stop if
identity resolution prompts or differs; no trust workaround. Hash the signed
executable and canonical bundle inventory anew, create a fresh native manifest,
and verify archive extraction/signature again. Old unsigned or signed hashes
cannot identify the new app. Matching requirements do not prove actual TCC
permission or native runtime behavior; those remain later owner-present checks.

README is unchanged: this prepares a debug artifact and enables no normal app
setup path. The next readiness gate is reviewed exact source/build evidence,
private context/media/package validation and explicit in-app scope consent;
mock archive tests establish neither capture nor useful assistance. The current
observed bundle requires no links or extended metadata; only an actual selected
build can prove it fits this conservative contract.
