# Live startup cancellation

This native prerequisite supports controllable participation cues: a Stop request must prevent a delayed startup from opening capture, and queued speech must not restart evaluated cues after processing permission is revoked. It does not establish meeting usefulness or native device reliability.

## Implemented boundary

`start_live_session` reserves one startup ticket before verifying or loading the speech model. The blocking loader owns that ticket until it exits. Stop cancels it; loading already in progress may finish, but its result cannot install a live engine or request capture. Another start is rejected until that loader releases its reservation. Failure, panic and cancellation release ownership for an explicit retry.

After installing the live engine, microphone startup records its capture generation in that exact session before requesting permission. A stopped or replaced session rejects the reservation. Stop can therefore retire that generation while permission or device startup is pending; a late device response cannot revive it or stop a newer capture. The callback records ownership without holding the microphone mutex.

Explicit Stop, end-session and microphone-loss cleanup revoke development evaluator permission under the runtime lock before queued transcription drains. Normal live capture still uses the local phrase rules. No processing adapter is activated by this change.

## Headless acceptance

Seven fictional regression tests exercise the production runtime and microphone gates without loading a model, requesting permission, opening a device or contacting a service:

- Stop during a gated load prevents engine installation and blocks overlapping loads; a later explicit start succeeds.
- Cancellation before the worker starts skips its loader entirely.
- A failed or panicking loader releases ownership for retry.
- Foreign, cancelled and previous-session tickets cannot install or claim a new session's capture.
- Stop revokes processing and pending reviews before queued speech enters the transcript; manual notes remain, and the fictional evaluator receives no work.
- Stop between engine installation and microphone reservation rejects the permission path.
- Stop after generation registration retires that start; a late fictional stream is dropped without being played.

Run `cargo test --manifest-path src-tauri/Cargo.toml --locked` for these and the existing lifecycle tests. Compile the actual startup wrapper with `cargo check --manifest-path src-tauri/Cargo.toml --locked --features local-whisper`; compilation performs no inference.

## Remaining acceptance

The current notebook serializes commands and disables its actions while Start awaits model loading. This change does **not** expose an interactive Cancel-start action there. [Scoped capture Stop](scoped-capture-stop.md) now carries stable operation ownership across loading and live installation, and the test-mounted controls display distinct loading/cancelling states. Integrating them into the notebook with reachable cancellation is still required; fresh processing approval remains blocked during drain.

Real microphone permission, device teardown, app shutdown and cross-window operation still need an explicit native check. No real capture or model inference was used for this acceptance. Signed distribution, Granola account import, accessibility and the comparison against no assistance remain separate release gates.
