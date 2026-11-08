# Local transcription check

Status: developer check, 8 November 2026; live session added 9 November 2026. In builds with the `local-whisper` feature, the app's live session routes the microphone to a transcription worker on the device. This page records how the local recognizer is checked and what that check shows.

## What exists

The optional `local-whisper` Cargo feature adds `LocalWhisper`, a [Transcriber](architecture.md) that runs whisper.cpp in-process on the transcription worker thread through the `whisper-rs` crate. It reads only the model file it is given: it downloads nothing, opens no network connection, and writes no audio to disk. Whisper does not separate speakers, so every recognized line is labelled `Speaker`. The feature is off by default, so ordinary builds and CI do not compile whisper.cpp. Building it needs CMake and a C++ toolchain.

`Engine::live()` creates a session with no scripted demo lines, for transcript input through `Engine::ingest`.

The app looks for the model at `TALKQTE_WHISPER_MODEL`, or at `models/ggml-tiny.en.bin` in its data folder. **Start live session** loads it before opening the microphone, so a missing or unreadable model is reported without starting capture. The capture callback feeds the [audio tap](architecture.md); a runner thread moves 3-second chunks to the worker every 250 ms and the worker's lines go to `Engine::ingest`. Stop releases the microphone first, then transcribes what was queued, waiting up to 10 seconds; End discards it.

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

`examples/replay_clip.rs` replays a clip into a live session in real time. Each chunk is handed to the worker once that much audio time has passed, while the engine clock follows real time as in the app. The replay prints:

- when a cue is shown, and whether it expired, was withdrawn, or was cleared by End;
- the worker's counts and its largest backlog.

It prints no transcript text. Clips over 32 MiB are refused. With `--report-every-ms`, it prints the backlog and line count periodically. Memory and CPU appear too when `ps` is available, which it is not under `sandbox-exec`. At the end it prints the speech-to-transcript delay: median, 95th percentile, and maximum.

With `--end-at-ms`, the session ends at that moment. The check fails unless audio was still queued or being transcribed at End, so an End between chunks cannot pass vacuously. Work already in progress is then allowed to finish, so late lines meet the engine's own refusal. The check fails if anything changes after End.

```sh
cd src-tauri
cargo run --features local-whisper --example replay_clip -- \
  --model "$HOME/.local/share/talkqte-models/ggml-tiny.en.bin" \
  --clip /tmp/talkqte-meeting.wav --chunk-ms 5000 [--end-at-ms 10000]
```

A fictional two-voice meeting clip, with 1.5 seconds of silence between lines:

```sh
cd /tmp && i=0
while IFS='|' read -r voice line; do
  i=$((i+1)); say -v "$voice" -o "line$i.aiff" "$line"
  afconvert -f WAVE -d LEI16@16000 -c 1 "line$i.aiff" "line$i.wav"
done <<'EOF'
Samantha|Let's plan the welcome guide for new garden visitors.
Daniel|Someone can take the first draft of the welcome guide.
Samantha|It should cover where to find the tools and how to water the seedlings.
Daniel|We should have it ready soon.
Samantha|Jordan will take the first draft.
Daniel|Let's have it ready by Friday.
Samantha|We could either print the guide or put a small sign by the gate.
Daniel|Let's go with the sign.
EOF
python3 -I -c '
import wave
with wave.open("talkqte-meeting.wav", "wb") as out:
    out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
    for n in range(1, 9):
        with wave.open(f"line{n}.wav") as part:
            out.writeframes(part.readframes(part.getnframes()) + bytes(48000))
'
```

## Recorded result

Fictional three-sentence clip (about 8 seconds: an owner, a timing, and a decision line), `tiny.en` model, Apple M5 Pro, macOS 26.4, debug build, network denied by `sandbox-exec`. Three runs:

| Measure                                     | Result                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Lines recognized and accepted by the engine | 3 of 3, every run                                                      |
| Question raised                             | "Who will take the first draft?", sourced to the recognized owner line |
| Submit to first line in the engine          | 150–158 ms                                                             |
| Peak memory of the test process             | about 210 MB                                                           |

Real-time replay of the 30.4-second two-voice meeting clip in 5-second chunks, same machine and model, network denied, debug build:

| Run                        | Result                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full clip                  | "Who will take the first draft?" shown 5.2 s in, after the first chunk, sourced to the recognized owner line. Withdrawn at 20.2 s with 2.3 s of display time left, after "Jordan will take the first draft." All 9 recognized lines accepted; no errors or drops; largest backlog 1 chunk. The cooldown after the answer kept the timing and decision lines quiet. |
| End at 10 s                | End came while one chunk was being transcribed and cleared the question. That chunk's 2 late lines were refused by the engine, and nothing changed after End: no new lines, same revision.                                                                                                                                                                         |
| End between chunks (7.5 s) | Refused as a vacuous check, as designed.                                                                                                                                                                                                                                                                                                                           |

These are short, clean synthetic clips with two system voices on one machine.

### Sustained session

A 10-minute replay of the two-voice meeting clip repeated 20 times, in real time, with `tiny.en`, a release build, 5-second chunks, and the network denied. Memory and CPU were sampled with `ps` from outside the sandbox every 30 seconds, because the sandbox blocks `ps`.

| Measure                    | Result                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio handled              | 607.9 s in 122 chunks: 180 lines accepted, 0 dropped, 0 recognizer failures, 0 refused                                                                                                        |
| Backlog                    | Never more than 1 chunk, so recognition kept up with real time throughout                                                                                                                     |
| Speech-to-transcript delay | Median 5.14 s, 95th percentile 5.21 s, maximum 5.32 s, measured from the start of a recognized line to the engine accepting it. Almost all of this is waiting for the 5-second chunk to fill. |
| Memory                     | About 238 MB in the first two minutes, then steady at 197–204 MB to the end; no growth across 10 minutes                                                                                      |
| CPU                        | 42.7 s of processor time over 600 s, about 7% of one core                                                                                                                                     |

Chunk length sets the delay. On the 30-second meeting clip:

| Chunk | Delay (median) | Question shown | Question withdrawn |
| ----- | -------------- | -------------- | ------------------ |
| 2 s   | 2.15 s         | 6.1 s          | 18.3 s             |
| 3 s   | 3.13 s         | 6.2 s          | 18.1 s             |
| 5 s   | 5.16 s         | 5.3 s          | 20.2 s             |

Shorter chunks deliver lines sooner, but fixed-length chunks cut words at their edges, which delayed the first question slightly. Splitting chunks at pauses in speech would keep the lower delay without cutting words; that is the next improvement to evaluate.

These figures describe one clean synthetic voice pair on one Mac. They do not include capture, the companion window, the other side of a call, noise, or other hardware, and they are inputs to the budget proposal, not budgets. It does not measure accuracy on real meetings, noisy audio, overlapping speakers, sustained sessions, or other hardware, and it is not a latency or resource budget.

## Still needed

- Model delivery: planned in the [model delivery plan](model-delivery.md); not implemented.
- A live session on real hardware: permission, release on Stop and End, and delay with the companion showing.
- Sustained-session measurements of delay, memory growth, CPU use, and dropped audio.

whisper.cpp is MIT-licensed and `whisper-rs` is released under the Unlicense. Any distributed build that enables this feature must include the whisper.cpp license notice.
