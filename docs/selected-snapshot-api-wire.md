# Selected snapshot request preparation and explicit v2 wiring

The v1 helpers in `scripts/cue-selected-snapshot.mjs` remain pure versioned
validators, local citation checkers and API parameter constructors. The module
never invokes an SDK or reads a credential. Explicit selected-context v2 wiring
now imports it through `cue-selected-context.mjs` in broker, worker and launcher
paths; the API core also reaches it through `cue-selected-context.mjs`.
The opt-in v2 path
constructs selected API parameters; the v1 helpers alone do not activate a route.
Legacy serializers, 10-word prompts, API state grammars and real
`without_notes()` defaults remain unchanged. The standalone CLI is not extended.

The new input separates current `events` from historical `priorNotes`. Only
existing file/Granola labels are accepted; there is no Tactiq adapter. Notes
carry existing metadata and a canonical decimal u64 snapshot revision string,
including native zero and the unknown Granola sentinel one without claiming a
known provider version. All copies are explicitly `not_verified`. No missing
date, revision or provider identity is invented.

Validation caps total sources at 32, prior notes at 20, titles at 200 Unicode
scalars, excerpts at 2,000 scalars and source text at 4,096 UTF-8 bytes. Existing
32,768-byte component bounds remain. The new policy additionally caps the
actual JSON user-message string at 16,384 UTF-8 bytes and the complete prepared
frame, including envelope/framing, at 65,536 bytes. JSON escaping and astral
Unicode count correctly. No partial selection or truncation is permitted.
These are input policies, not model token/cost or measured latency bounds.
Model reservation and spending checks are independent prerequisites.

Fake parameter tests capture the exact string that the explicit selected API
path places in `messages[0].content`, the unchanged three state-dependent provider
grammars, and a separately appended snapshot policy. Broker/native checks
still enforce citation membership, uniqueness and max four; state-changing
proposals cite speech. Rust must also recheck session/grant generation, source
fingerprints/revisions, and an under-18-second cited speech anchor at apply.
Wire membership cannot authorize processing or establish semantic relevance.

The synthetic fixture `scripts/fixtures/selected-snapshot-input.json` is shared
with the separately based native serializer change. The native change drives
its serializer through the existing runtime approval/cancellation tests; this
JS delta does not claim runtime lifecycle enforcement on its own.

The public v2 API source and native selected-context source define the processor
policy/prompt identity and exact selected-source disclosure. Next blocker: review
and validate their distinct ancestry together, including paired native IPC and
runtime acceptance; source definitions do not establish that pairing.
Activation and any bounded fictional provider comparison need separate
assignments. Imported context is not processing permission. No paid run,
account, native IPC, useful-assistance or latency acceptance is established.
Granola identity/refresh/account and Tactiq source mapping remain open.

Selected-mode string policy rejects Unicode Cc controls except LF/TAB in
text, titles, names and cue metadata. IDs reject every Cc, including LF/TAB.
Invalid content rejects the exact selection; it is never sanitized. Shared
positive LF/TAB/astral and negative CR/U+0001/DEL/C1 fixtures check this domain
against the native constructor-plus-serializer path. Legacy validation is
unchanged.
