// Reads one finished lab recording and prints what its own frames and sound
// show, for scripts/cue-lab-take-timing.mjs (docs/lab-take-timing.md).
//
//   lab-recording-observe cue-area /absolute/recording.mov <x> <y> <width> <height>
//   lab-recording-observe audio-level /absolute/recording.mov
//
// cue-area: for every video frame, the share of sampled pixels inside the
// rectangle (output pixels, top-left origin) whose luma differs from the
// first frame's by more than 24 of 255. Every second pixel of every second
// row is sampled. Prints {"width":…,"height":…,"frames":[[ms,share],…]} with
// each frame's presentation time in milliseconds on the movie's own clock.
//
// audio-level: the first audio track mixed to one 48 kHz channel, as the
// level of each 10 ms window in dBFS (-120 for digital silence). Prints
// {"windowMs":10,"startMs":…,"db":[…]}.
//
// It reads with AVFoundation only, keeps no pixels or sound and writes
// nothing. Exit codes: 64 usage, 65 nothing usable in the file, 66 the file
// could not be read, 67 the rectangle is outside the picture, 68 too long.
import AVFoundation
import CoreVideo
import Foundation

@main
struct RecordingObserve {
  static let maxFrames = 100_000
  static let maxWindows = 120_000

  static func fail(_ code: Int32) -> Never {
    exit(code)
  }

  static func ms(_ time: CMTime) -> Double {
    Double(time.value) * 1000 / Double(time.timescale)
  }

  static func main() async {
    let a = CommandLine.arguments
    guard a.count >= 3, a[2].hasPrefix("/") else { fail(64) }
    let asset = AVURLAsset(
      url: URL(fileURLWithPath: a[2]),
      options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    if a[1] == "cue-area", a.count == 7 {
      let numbers = a[3...6].compactMap { Int($0) }
      guard numbers.count == 4, numbers[0] >= 0, numbers[1] >= 0, numbers[2] > 1,
        numbers[3] > 1
      else { fail(64) }
      await cueArea(asset, x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3])
    } else if a[1] == "audio-level", a.count == 3 {
      await audioLevel(asset)
    } else {
      fail(64)
    }
  }

  static func cueArea(_ asset: AVURLAsset, x: Int, y: Int, w: Int, h: Int) async {
    guard let track = try? await asset.loadTracks(withMediaType: .video).first,
      let reader = try? AVAssetReader(asset: asset)
    else { fail(66) }
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { fail(66) }
    var reference: [UInt8]? = nil
    var rows: [String] = []
    var width = 0
    var height = 0
    while let buffer = output.copyNextSampleBuffer() {
      guard let image = CMSampleBufferGetImageBuffer(buffer) else { continue }
      let time = CMSampleBufferGetPresentationTimeStamp(buffer)
      guard time.isValid, time.isNumeric else { continue }
      CVPixelBufferLockBaseAddress(image, .readOnly)
      width = CVPixelBufferGetWidth(image)
      height = CVPixelBufferGetHeight(image)
      guard x + w <= width, y + h <= height,
        let base = CVPixelBufferGetBaseAddress(image)?.assumingMemoryBound(to: UInt8.self)
      else {
        CVPixelBufferUnlockBaseAddress(image, .readOnly)
        fail(67)
      }
      let stride = CVPixelBufferGetBytesPerRow(image)
      var luma: [UInt8] = []
      luma.reserveCapacity((w / 2 + 1) * (h / 2 + 1))
      for row in Swift.stride(from: y, to: y + h, by: 2) {
        for column in Swift.stride(from: x, to: x + w, by: 2) {
          let p = base + row * stride + column * 4
          let red: Int = Int(p[2]) * 299
          let green: Int = Int(p[1]) * 587
          let blue: Int = Int(p[0]) * 114
          luma.append(UInt8((red + green + blue) / 1000))
        }
      }
      CVPixelBufferUnlockBaseAddress(image, .readOnly)
      if reference == nil { reference = luma }
      var changed = 0
      for i in 0..<luma.count where abs(Int(luma[i]) - Int(reference![i])) > 24 {
        changed += 1
      }
      rows.append(
        String(format: "[%.4f,%.5f]", ms(time), Double(changed) / Double(luma.count)))
      if rows.count > maxFrames { fail(68) }
    }
    guard reader.status == .completed, !rows.isEmpty else { fail(65) }
    print("{\"width\":\(width),\"height\":\(height),\"frames\":[\(rows.joined(separator: ","))]}")
  }

  static func audioLevel(_ asset: AVURLAsset) async {
    guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
      let reader = try? AVAssetReader(asset: asset)
    else { fail(66) }
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
        AVLinearPCMIsBigEndianKey: false, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1,
      ])
    reader.add(output)
    guard reader.startReading() else { fail(66) }
    let window = 480
    var start: Double? = nil
    var sum = 0.0
    var count = 0
    var levels: [String] = []
    while let buffer = output.copyNextSampleBuffer() {
      if start == nil {
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard time.isValid, time.isNumeric else { fail(65) }
        start = ms(time)
      }
      guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
      var length = 0
      var pointer: UnsafeMutablePointer<Int8>? = nil
      guard
        CMBlockBufferGetDataPointer(
          block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length,
          dataPointerOut: &pointer) == kCMBlockBufferNoErr, let pointer
      else { fail(65) }
      pointer.withMemoryRebound(to: Float.self, capacity: length / 4) { samples in
        for i in 0..<(length / 4) {
          let v = Double(samples[i])
          sum += v * v
          count += 1
          if count == window {
            let power = sum / Double(window)
            levels.append(
              power <= 1e-12 ? "-120" : String(format: "%.1f", max(-120, 10 * log10(power))))
            sum = 0
            count = 0
          }
        }
      }
      if levels.count > maxWindows { fail(68) }
    }
    guard reader.status == .completed, let start, !levels.isEmpty else { fail(65) }
    print(
      "{\"windowMs\":10,\"startMs\":\(String(format: "%.4f", start)),\"db\":[\(levels.joined(separator: ","))]}"
    )
  }
}
