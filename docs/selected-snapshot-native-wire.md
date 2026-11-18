# Selected snapshot wire format — inert preparation

This change prepares an opt-in input format; no processor, launcher, broker or
worker entrypoint selects it. Real registrations retain `without_notes()` and
the legacy serializer still refuses prior notes. Importing a snapshot does not
grant processing permission. No Tactiq adapter or provider support is added.

`Request::selected_snapshot_input` serializes only the immutable request built
by the existing permission bridge, keeping current conversation in `events`
and historical context in `priorNotes`. The latter carries its existing ID,
provider, title, date, excerpt and an exact decimal-string snapshot revision.
Zero and the unknown-version sentinel one stay opaque values, not evidence of
provider freshness. All snapshots are labeled `not_verified`; no date, revision
or last-confirmed time is invented.

The new mode caps the complete serialized input at 16,384 UTF-8 bytes, including
escaping and metadata. Its frame preparation caps the complete envelope and
newline at 65,536 bytes. Existing source/count/component bounds remain; an
oversized exact selection fails rather than dropping selected notes. These are
input policies, not token, cost or latency guarantees. New optional transcript
history is not enabled or combined with this mode.

The shared synthetic fixture in `scripts/fixtures/selected-snapshot-input.json`
is also consumed by the separately based JS validator's tests. Native tests
cover exact u64 strings, malformed namespace/date/source classes, Unicode and
input/frame byte boundaries. The runtime handoff tests run the serializer
inside their gated scripted worker, preserving checks of explicit approval,
source changes/removal, Stop/revoke, held evidence and no rollback. Execution
results belong to the exact reviewed commit; adding tests alone is not a pass.

Next blocker: explicitly align and review the real API broker/request-builder
ancestry, then review the input policy, prompt identity, data disclosure and
source/citation validation before any activation assignment. The JS API
contract is a separate change on a distinct source baseline. No real account,
provider effectiveness, native IPC delivery, latency or listening outcome is
established by these inert helpers. Granola identity/refresh/account acceptance
and Tactiq source mapping remain open. See [the processing handoff](selected-context-handoff.md).
