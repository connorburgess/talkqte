# Take timing estimates from the recording

The [evidence report](lab-evidence-report.md)'s "Timing targets" rows stay unmeasured until two things are true. Heard lines must be joined to transcript lines, and painted frames to cues, by exact identity. Every clock must also be bridged by a declared anchor. A real take's evidence has neither, so those rows read "unmeasured" even for a completed take. `scripts/cue-lab-take-timing.mjs` derives what the recording itself shows and labels every figure as an **estimate**. Nothing it produces feeds the report's pass/fail rows or confirms a budget.

```sh
npm run lab:take-timing -- --manifest <evidence>/tq-evidence-XXXX/manifest.json \
  --out <evidence>/tq-evidence-XXXX/timing-estimates
```

The paths are placeholders. The tool loads the evidence through the report's own checks (modes, sizes, sha256, and the recording streamed without decoding). It reads `take-outcome.json` beside the manifest (or `--outcome`), and builds `scripts/lab-recording-observe.swift` into a private temporary folder with `/usr/bin/swiftc` (AVFoundation only, no new dependency). It writes a **new** mode-0700 folder with mode-0600 `estimates.json` and `estimates.md`. It needs exactly one native timing log and a recording, launches nothing, and deletes nothing. Keep the output private; it names cue and segment identities.

## Cue paint from the recording

- **Where:** the companion window's rectangle in the picture, from the recorder's `geometry` in the take outcome. The picture is the union of both windows at the picture's pixel scale, as the capture helper draws it.
- **What is measured:** for each video frame, the share of sampled pixels in that rectangle (every second pixel of every second row) whose luma differs by more than 24 of 255 from the first recorded frame. The first frame precedes any cue: the recorder accepts it before the player's render start, and no cue can come before speech.
- **Episodes:** the area is empty at a share of at most 0.05 (the idle controls animate a little) and shows a cue from 0.5. A change that never reaches 0.5 is a blip, not a cue. `video.cue-painted` is the first frame that leaves empty. `video.cue-cleared` is the first frame back at empty, after the card's fade-out of about a quarter of a second.
- **Uncertainty:** the change happened no later than that frame. It happened no earlier than the previous frame or one capture interval before it (1/30 s plus one 60 Hz refresh), whichever is earlier. The event is placed at the middle of that window with half its width as uncertainty, on the `recording` clock with `basis: "frame"`. Painted means captured on screen, not seen by a person.
- **Join to cues:** by order only. The join holds when the number of episodes equals the number of published cues, every visible duration and every gap between successive cues agrees with native's `cue_published`/`cue_cleared` to within 500 ms, and, with a clock bridge, no episode is painted before its cue was published. Otherwise nothing is joined and the reason is given. This is not an identity, so the painted events are not written into the evidence.

## Heard ends and the clock bridges

- **Recorded speech:** the recording's own sound (the player's audio as captured), mixed to one channel, in 10 ms windows. Speech is any window above the midpoint, in dB, between the room tone (10th percentile) and speech (95th percentile). Pauses under 150 ms stay inside one stretch. The edge uncertainty is one window.
- **Node ↔ native logger:** the broker's clock calibration when the take outcome has `clockCalibration` (runs from this change on): native session elapsed ↔ Node midpoint, half the round trip, carried through the session start row (±2 ms). Otherwise a causal bracket. The runner received native's Listening row (`dev_source_observation` `listening`) after native wrote it, and native latched Stop (`dev_stop` `latched`) after the runner had seen the media end (`speech.render-end`). It is refused when empty or wider than 200 ms. Both clocks count the same Mach time base.
- **Recording ↔ node:** the first recorded sound after digital silence is taken as the player's measured render start (`speech.render-start`). Its uncertainty is half a window plus one AAC frame plus the render start's own. The capture path's audio latency is not measured, and the bridge is refused when the onset is earlier than the recording could have held the render start. The cross-check: through the bridges, each joined cue's painted frame should follow its publication by a few frames.
- **Heard end of a final:** the end of the last stretch of recorded speech that a transcription final overlaps through the bridges, provided no other final overlaps that stretch. A stretch shared by two finals leaves both unknown (`ambiguous`). This is a time join, not an identity. Finals join their transcript lines exactly, as in the report (`c{session}-{stream}-{seq}`, one match only).

## What it reports

- Heard end → transcript line per final, beside the report's native "Final end of speech → transcript line" and the difference between the service's end of speech and the recorded end.
- Per joined cue: painted and native visible durations; published → painted; heard end → painted, both from the line the cue cites (`source_id`, `transcript:<segment>`) and from the request's newest line (`through_segment`).
- Counts, median, 95th percentile and maximum of each, with the budget targets named for comparison. None is a pass or a fail.

**How it differs from the report's native figure.** "Final end of speech → transcript line" starts from the transcription service's own end-of-speech time, on the app's clock. The estimate here starts from where the recorded sound ends, so it also includes how far the service's end is from the sound's. Both remain distinct from the budget row.

## What would make them exact

- A heard end per line observed by the player itself (its render clock at each line end, from a media line schedule), with an explicit line-to-transcript-segment identity event. The fixed meeting carries no line schedule, only its hash and duration; fresh-scenario manifests do ([fresh scenarios](lab-fresh-scenarios.md)), but neither the media loader nor the player passes it on.
- A recording clock anchor declared by the capture helper (the first frame's host time mapped to the runner's clock), in place of the recorded-sound onset.
- Painted frames joined to cues by identity: the companion drawing the cue identity it shows, or a per-cue paint receipt.

## Checks

`scripts/cue-lab-take-timing.test.mjs` uses synthetic frames, sound levels, native rows and a writer-built evidence folder. It covers the rectangle, episodes, blips and frame-interval uncertainty, the onset, stretches and pauses, both bridges and their refusals, the order join and its refusals, ambiguous finals, and private output that never overwrites. Compile the helper with:

```sh
swiftc -O -parse-as-library -swift-version 5 -o /tmp/lab-recording-observe \
  scripts/lab-recording-observe.swift -framework AVFoundation -framework CoreMedia -framework CoreVideo
```
