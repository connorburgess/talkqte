# First supported setup and budgets (proposal)

Status: proposal for the owner to agree, 9 November 2026. Nothing here is a support claim or a measured guarantee. The [product readiness plan](product-readiness.md) asks for budgets on named Macs before the benchmark. This page proposes them, using the synthetic measurements so far as a starting point, so later results can pass or fail against a fixed target.

## Proposed first supported setup

| Area         | Proposal                                               | Reason and evidence                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac          | Apple silicon (M1 or later)                            | Local transcription is the heaviest work. Only an Apple M5 Pro has been measured so far. An M1 with 8 GB is the proposed lowest supported Mac and must be measured before the budgets are confirmed. |
| macOS        | macOS 14 Sonoma or later                               | The app currently builds for macOS 13 or later. Narrowing to 14 limits the test matrix; this needs checking against the capture APIs chosen for system audio. Only macOS 26.4 has been tested.       |
| Language     | English                                                | The default `tiny.en` model is English-only ([model delivery plan](model-delivery.md)).                                                                                                              |
| Meeting apps | Google Meet in Chrome, then Zoom desktop               | Meet matches the phone goal in the [mobile plan](mobile.md). Each app must pass the native companion checks in the [validation record](native-validation.md) before it is listed.                    |
| Audio        | Built-in microphone and speakers, and wired headphones | Bluetooth and external interfaces come later. Capturing the other side of a call is not implemented yet.                                                                                             |

## Proposed budgets

Measure on the lowest supported Mac, on battery and on power, with a fictional two-voice meeting of at least 60 minutes. A release candidate passes only if every budget holds.

| Budget                      | Proposed target                                                                                                 | Measured so far (M5 Pro, synthetic, 10 minutes)                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speech to transcript line   | Median ≤ 3.5 s, 95th percentile ≤ 5 s                                                                           | 5-second chunks: median 5.14 s, 95th percentile 5.21 s. 3-second chunks: median 3.13 s. Meeting this budget needs 3-second or pause-based chunks. |
| Trigger line to visible cue | 95th percentile ≤ 5 s after the line ends                                                                       | Not yet measured with the companion window                                                                                                        |
| Stale cues                  | A question never first appears more than 18 s after its trigger                                                 | Enforced by the engine (`CUE_MS`)                                                                                                                 |
| Dropped audio               | 0 chunks dropped in 60 minutes; backlog never above 2 chunks                                                    | 0 dropped in 10 minutes; backlog never above 1                                                                                                    |
| Transcription memory        | ≤ 400 MB, with < 10% growth from minute 10 to minute 60                                                         | About 200 MB, flat from minute 2 to minute 10                                                                                                     |
| Whole-app memory            | ≤ 600 MB during a session                                                                                       | Not yet measured with the app running                                                                                                             |
| CPU                         | Average ≤ 15% of one core on the lowest supported Mac                                                           | About 7% of one M5 Pro core                                                                                                                       |
| Battery                     | ≤ 8% per hour on the lowest supported MacBook, with the meeting app running and the measurement method recorded | Not measured                                                                                                                                      |
| Stop and End                | The microphone is released within 1 s of Stop; no update after End; transcription stops within 2 s              | End verified in replay; worker stop waits at most 2 s (`STOP_WAIT`); microphone release seen by the owner, not timed                              |
| Device loss                 | A stalled or removed input is reported within 3 s, with no automatic restart                                    | Watchdog set to 3 s (`INPUT_TIMEOUT`); not tested on a real device                                                                                |
| Model load                  | Ready within 2 s of starting a session, or a clear message                                                      | Not timed separately                                                                                                                              |

## Not decided here

- Who owns releases and support, pricing, and acquisition targets. These remain open in the readiness plan.
- Intel Macs, Windows, Linux, and phones. Each platform gets its own matrix in the [platform plan](platforms.md).

## To confirm this proposal

1. The owner agrees or adjusts the setup and targets above.
2. Get access to an M1 Mac with 8 GB, and add a 60-minute synthetic replay plus a battery measurement method.
3. Re-measure after pause-based chunking, and once the companion window and real capture are connected.
