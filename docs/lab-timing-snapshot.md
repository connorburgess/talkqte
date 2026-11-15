# Bounded post-release native timing snapshot

The native timing writer may remain open after source release. Closing the JS
observer does not close that writer, acknowledge a flush or exit the app.
`snapshotLabTiming` therefore preserves the live original and creates a separate,
write-once private snapshot. No native lifecycle control is added.

Call only after observed exact source release and recorder completed-file
finalization. Supply the launcher's frozen `timingFileIdentity` with exact run ID
and device/inode strings; pathname equality alone is insufficient. The reader
requires the canonical external 0600 regular file, owned by the current user,
without symlink/identity substitution. It opens once and fixes a cutoff at the
smaller of the observed initial size and the configured byte limit. Later appends
are not chased. Truncation/identity loss, malformed/duplicate/wrong-run JSON,
invalid UTF-8 or oversized complete records fail without altering the original.

Only complete newline-terminated records before that cutoff and row limit are
copied, preserving their raw bytes and lexical numeric identities. Defaults are
8 MiB, 10,000 rows and 64 KiB per record; hard ceilings are 16 MiB, 50,000 rows and
64 KiB. The private 0700 snapshot directory contains a 0600 JSONL and `SNAPSHOT.json`.
Both are closed before return. This is a logical write-once snapshot, not an OS
immutable-file flag; later corruption is detected by its SHA256. A zero-record
snapshot supplies coverage metadata, not a usable native event artifact.

Coverage explicitly retains initial/end observed size, cutoff, read/copied bytes,
row count, omitted/unobserved bytes, growth, row-limit status and trailing partial
bytes. The row cap latches at the accepted row boundary when cutoff bytes remain;
excluded oversized, malformed or unterminated tails are not inspected. When
row-limited, trailing-partial count is unknown because remaining bytes were not
parsed. The cutoff time is a local receipt, not native event/flush time.
`nativeWriterMayRemainOpen`, `unknownLateRecords` are true and
`completeRunCoverage` is false even when every observed byte ends at a newline.
Missing late/lossy records stay unknown. A snapshot never proves native app exit.

The evidence writer can attach the completed snapshot with `sealed: true` and
`snapshotCoverage`. That label describes only the completed snapshot, never the
raw live file or complete run coverage. Its copied hash, bytes and rows must match
the coverage; the allowlisted coverage is retained in the private artifact
manifest. The original remains at its original path. Keep the native app owned
and report whether it is still running independently of confirmed source/player/
recorder/provider cleanup. Do not invent a flush acknowledgement or terminate the
app to claim release.

Offline checks use private fictional files and injected append/truncation. They
exercise complete-prefix selection, limits, exact owned-file identity, malformed
records, preservation and hash-bound writer attachment. A harmless launcher
fixture checks timing-file identity provenance. No native app, player, capture,
transcription or provider is executed. README is unchanged for internal tooling.
