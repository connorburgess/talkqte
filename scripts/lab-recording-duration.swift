// Prints the duration of one finished lab recording, for the evidence
// writer's `durationMs` (scripts/cue-lab-take.mjs, docs/lab-take-runbook.md).
//
//   lab-recording-duration /absolute/path/recording.mov
//
// It opens the file with AVFoundation, asks for the precise duration, and
// prints one JSON line: {"durationMs":<number>,"timescale":<integer>}.
// The duration is exact to the movie's own timescale (1/timescale s). It
// reads no pixels or sound and writes nothing. Exit codes: 64 usage, 65 no
// usable duration, 66 the file could not be read.
import AVFoundation
import Foundation

@main
struct RecordingDuration {
  static func fail(_ code: Int32) -> Never {
    exit(code)
  }

  static func main() async {
    let arguments = CommandLine.arguments
    guard arguments.count == 2, arguments[1].hasPrefix("/") else { fail(64) }
    let url = URL(fileURLWithPath: arguments[1])
    let asset = AVURLAsset(
      url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    let duration: CMTime
    do {
      duration = try await asset.load(.duration)
    } catch {
      fail(66)
    }
    guard duration.isValid, duration.isNumeric, !duration.isIndefinite,
      duration.timescale > 0, duration.value > 0
    else { fail(65) }
    let ms = Double(duration.value) * 1000 / Double(duration.timescale)
    print("{\"durationMs\":\(ms),\"timescale\":\(duration.timescale)}")
  }
}
