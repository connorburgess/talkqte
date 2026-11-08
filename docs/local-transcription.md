# Local transcription check

Status: developer check, 8 November 2026. The app does not transcribe meetings, start a transcription worker, or route the microphone to one. This page records how the local recognizer is checked and what that check shows.

## What exists

The optional `local-whisper` Cargo feature adds `LocalWhisper`, a [Transcriber](architecture.md) that runs whisper.cpp in-process on the transcription worker thread through the `whisper-rs` crate. It reads only the model file it is given: it downloads nothing, opens no network connection, and writes no audio to disk. Whisper does not separate speakers, so every recognized line is labelled `Speaker`. The feature is off by default, so ordinary builds and CI do not compile whisper.cpp. Building it needs CMake and a C++ toolchain.

`Engine::live()` creates a session with no scripted demo lines, for transcript input through `Engine::ingest`.

## Run the check

Use a fictional synthetic clip only: 16 kHz, mono, 16-bit PCM WAV, at most 30 seconds. Keep the model and clip outside the repository. The [lab's local Whisper smoke test](https://github.com/connorburgess/talkqte-lab) describes how to obtain the `tiny.en` model and verify its checksum, and how to make a synthetic clip.

```sh
cd src-tauri
TALKQTE_WHISPER_MODEL="/absolute/path/to/ggml-tiny.en.bin" \
TALKQTE_WHISPER_CLIP="/absolute/path/to/synthetic.wav" \
  cargo test --features local-whisper a_synthetic_clip_is_transcribed_locally -- --nocapture
```

Without both variables the test is skipped. It sends the clip through the real worker into a live engine session. It passes when the recognizer produces lines without errors, an owner line raises "Who will take the first draft?", and that question's source is a recognized line. On macOS, run the built test binary under `sandbox-exec -p '(version 1)(allow default)(deny network*)'` to check that no network access is needed.

## Recorded result

Fictional three-sentence clip (about 8 seconds: an owner, a timing, and a decision line), `tiny.en` model, Apple M5 Pro, macOS 26.4, debug build, network denied by `sandbox-exec`. Three runs:

| Measure                                     | Result                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Lines recognized and accepted by the engine | 3 of 3, every run                                                      |
| Question raised                             | "Who will take the first draft?", sourced to the recognized owner line |
| Submit to first line in the engine          | 150–158 ms                                                             |
| Peak memory of the test process             | about 210 MB                                                           |

This is one short, clean, single-voice synthetic clip on one machine. It does not measure accuracy on real meetings, noisy audio, overlapping speakers, sustained sessions, or other hardware, and it is not a latency or resource budget.

## Still needed

- A synthetic clip in which a later line answers the question, to check withdrawal end to end.
- A replay command that starts and stops a worker with a session, so End during transcription can be checked in the app.
- Model delivery: where the model comes from, its integrity check, and its size. See the roadmap.
- Sustained-session measurements of delay, memory growth, CPU use, and dropped audio.

whisper.cpp is MIT-licensed and `whisper-rs` is released under the Unlicense. Any distributed build that enables this feature must include the whisper.cpp license notice.
