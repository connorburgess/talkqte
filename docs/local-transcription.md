# Local transcription check

Status: developer check, 8 November 2026. The app does not transcribe meetings, start a transcription worker, or route the microphone to one. This page records how the local recognizer is checked and what that check shows.

## What exists

The optional `local-whisper` Cargo feature adds `LocalWhisper`, a [Transcriber](architecture.md) that runs whisper.cpp in-process on the transcription worker thread through the `whisper-rs` crate. It reads only the model file it is given: it downloads nothing, opens no network connection, and writes no audio to disk. Whisper does not separate speakers, so every recognized line is labelled `Speaker`. The feature is off by default, so ordinary builds and CI do not compile whisper.cpp. Building it needs CMake and a C++ toolchain.

`Engine::live()` creates a session with no scripted demo lines, for transcript input through `Engine::ingest`.

## Run the check

Use a fictional synthetic clip only: 16 kHz, mono, 16-bit PCM WAV, at most 30 seconds. Keep the model and clip outside the repository.

Download the English-only `tiny.en` model from the [upstream whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp) and check it. The reviewed SHA-256 is `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`.

```sh
mkdir -p "$HOME/.local/share/talkqte-models"
curl --fail --location \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin \
  --output "$HOME/.local/share/talkqte-models/ggml-tiny.en.bin"
shasum -a 256 "$HOME/.local/share/talkqte-models/ggml-tiny.en.bin"
```

On macOS, make a fictional clip with a system voice and convert it:

```sh
say -o /tmp/talkqte-clip.aiff "Someone can take the first draft of the welcome guide. We should have it ready soon. We could either print the guide or put a small sign with a link by the gate."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/talkqte-clip.aiff /tmp/talkqte-clip.wav
```

```sh
cd src-tauri
TALKQTE_WHISPER_MODEL="/absolute/path/to/ggml-tiny.en.bin" \
TALKQTE_WHISPER_CLIP="/absolute/path/to/synthetic.wav" \
  cargo test --features local-whisper a_synthetic_clip_is_transcribed_locally -- --nocapture
```

Without both variables the test is skipped. It sends the clip through the real worker into a live engine session. It passes when the recognizer produces lines without errors, an owner line raises "Who will take the first draft?", and that question's source is a recognized line. On macOS, run the built test binary under `sandbox-exec -p '(version 1)(allow default)(deny network*)'` to check that no network access is needed.

## Real-time replay

`examples/replay_clip.rs` replays a clip into a live session in real time. Each chunk of audio is handed to the worker once that much time has passed, while the engine clock advances as in the app. It prints when a cue is shown, when it clears and how much time it had left, and the worker counts. It prints no transcript text. With `--end-at-ms`, it ends the session partway through and fails if anything changes afterwards.

```sh
cd src-tauri
cargo run --features local-whisper --example replay_clip -- \
  --model "$HOME/.local/share/talkqte-models/ggml-tiny.en.bin" \
  --clip /tmp/talkqte-answer.wav --chunk-ms 5000 [--end-at-ms 7000]
```

A clip in which a later line answers the question:

```sh
say -o /tmp/talkqte-answer.aiff "Someone can take the first draft of the welcome guide. [[slnc 3000]] It should cover where to find the tools. [[slnc 3000]] Jordan will take the first draft. [[slnc 2000]] Great, thanks."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/talkqte-answer.aiff /tmp/talkqte-answer.wav
```

## Recorded result

Fictional three-sentence clip (about 8 seconds: an owner, a timing, and a decision line), `tiny.en` model, Apple M5 Pro, macOS 26.4, debug build, network denied by `sandbox-exec`. Three runs:

| Measure                                     | Result                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Lines recognized and accepted by the engine | 3 of 3, every run                                                      |
| Question raised                             | "Who will take the first draft?", sourced to the recognized owner line |
| Submit to first line in the engine          | 150–158 ms                                                             |
| Peak memory of the test process             | about 210 MB                                                           |

Real-time replay of the 14.7-second answer clip in 5-second chunks, same machine and model, network denied, debug build:

| Run              | Result                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full clip, twice | "Who will take the first draft?" shown 5.2–5.3 s into the replay, after the first chunk, sourced to the recognized owner line. Withdrawn 14.9 s in, with about 3.2 s of its time left, after "Jordan will take the first draft." 4 lines, no errors or drops. |
| End at 7 s       | Question shown at 5.2 s; End at 7.0 s cleared it. The worker stopped without detaching, and nothing changed afterwards: no new lines, revision unchanged.                                                                                                     |

These are short, clean, single-voice synthetic clips on one machine. It does not measure accuracy on real meetings, noisy audio, overlapping speakers, sustained sessions, or other hardware, and it is not a latency or resource budget.

## Still needed

- Starting and stopping a worker with the app's own session controls, and showing a live session in the companion.
- Model delivery: where the model comes from, its integrity check, and its size. See the roadmap.
- A display for live sessions: `Engine::live()` has no fixed duration, so the UI must not show its duration as an end time.
- Sustained-session measurements of delay, memory growth, CPU use, and dropped audio.

whisper.cpp is MIT-licensed and `whisper-rs` is released under the Unlicense. Any distributed build that enables this feature must include the whisper.cpp license notice.
