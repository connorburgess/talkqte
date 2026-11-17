// Records exactly two windows, the meeting emulator's and the real TalkQTE
// companion's, with the emulator app's sound, using ScreenCaptureKit. It
// never records the whole screen: the picture is a display filtered to
// those two windows only, cropped to them, and the sound comes from the
// emulator app alone. If either window cannot be found it records nothing.
//
// Built and run by scripts/lab-window-record.mjs. It needs the Screen &
// System Audio Recording permission for the app that starts it (Terminal,
// for example); `--check` reports whether that is granted without asking.
//
//   lab-window-capture --check
//   lab-window-capture --list --apps "QuickTime Player,TalkQTE"
//   lab-window-capture --capture --emulator-app "QuickTime Player" \
//     [--emulator-title <text>] --companion-app TalkQTE \
//     --companion-title "TalkQTE companion" --seconds 120 --out <file.mov>
//
// It writes one JSON object a line to standard output: what it matched,
// when recording started and stopped (wall-clock milliseconds), and how
// many frames and sound buffers it wrote. Window titles of other apps are
// never printed.
import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  emit(["event": "error", "message": message])
  exit(code)
}

func wallMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

func parseArguments() -> [String: String] {
  var options: [String: String] = [:]
  var iterator = CommandLine.arguments.dropFirst().makeIterator()
  while let argument = iterator.next() {
    guard argument.hasPrefix("--") else { fail("Unknown argument \(argument).", code: 64) }
    let key = String(argument.dropFirst(2))
    if ["check", "list", "capture"].contains(key) {
      options[key] = "yes"
    } else if [
      "apps", "emulator-app", "emulator-title", "companion-app", "companion-title", "seconds",
      "out",
    ].contains(key) {
      guard let value = iterator.next() else { fail("\(argument) needs a value.", code: 64) }
      options[key] = value
    } else {
      fail("Unknown argument \(argument).", code: 64)
    }
  }
  return options
}

func frameDictionary(_ rect: CGRect) -> [String: Double] {
  [
    "x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width),
    "height": Double(rect.height),
  ]
}

final class Writer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let writer: AVAssetWriter
  let video: AVAssetWriterInput
  let audio: AVAssetWriterInput
  var started = false
  var frames = 0
  var audioBuffers = 0
  var problem: String?

  init(url: URL, width: Int, height: Int) throws {
    writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width,
        AVVideoHeightKey: height,
      ])
    video.expectsMediaDataInRealTime = true
    audio = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
      ])
    audio.expectsMediaDataInRealTime = true
    writer.add(video)
    writer.add(audio)
    super.init()
    if !writer.startWriting() { throw writer.error ?? CocoaError(.fileWriteUnknown) }
  }

  func stream(
    _ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard buffer.isValid else { return }
    switch type {
    case .screen:
      guard
        let attachments = CMSampleBufferGetSampleAttachmentsArray(
          buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
        let raw = attachments.first?[.status] as? Int,
        let status = SCFrameStatus(rawValue: raw), status == .complete
      else { return }
      if !started {
        writer.startSession(atSourceTime: buffer.presentationTimeStamp)
        started = true
        emit(["event": "started", "wallMs": wallMs()])
      }
      if video.isReadyForMoreMediaData, video.append(buffer) { frames += 1 }
    case .audio:
      // Sound before the first picture has nowhere to go.
      guard started else { return }
      if audio.isReadyForMoreMediaData, audio.append(buffer) { audioBuffers += 1 }
    default:
      return
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    problem = error.localizedDescription
  }
}

@main
struct Capture {
  static func main() async {
    let options = parseArguments()

    if options["check"] != nil {
      emit([
        "event": "check", "screenRecording": CGPreflightScreenCaptureAccess(),
        "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
      ])
      return
    }

    guard CGPreflightScreenCaptureAccess() else {
      fail(
        "Screen & System Audio Recording is not allowed for the app that started this. Allow it in System Settings, Privacy & Security, then start that app again.",
        code: 77)
    }

    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(
        true, onScreenWindowsOnly: true)
    } catch {
      fail("Could not list windows: \(error.localizedDescription)")
    }

    if options["list"] != nil {
      // Only the named apps' windows are listed, so nothing else of the
      // owner's appears.
      let apps = Set((options["apps"] ?? "").split(separator: ",").map(String.init))
      guard !apps.isEmpty else { fail("--list needs --apps.", code: 64) }
      for window in content.windows
      where apps.contains(window.owningApplication?.applicationName ?? "") {
        emit([
          "event": "window", "app": window.owningApplication?.applicationName ?? "",
          "title": window.title ?? "", "windowId": Int(window.windowID),
          "pid": Int(window.owningApplication?.processID ?? 0),
          "onScreen": window.isOnScreen, "frame": frameDictionary(window.frame),
        ])
      }
      return
    }

    guard options["capture"] != nil else {
      fail("Use --check, --list or --capture.", code: 64)
    }
    guard let emulatorApp = options["emulator-app"], let out = options["out"],
      let secondsText = options["seconds"], let seconds = Double(secondsText), seconds > 0,
      seconds <= 1800
    else {
      fail("--capture needs --emulator-app, --out and --seconds (up to 1800).", code: 64)
    }
    let companionApp = options["companion-app"] ?? "TalkQTE"
    let companionTitle = options["companion-title"] ?? "TalkQTE companion"

    let visible = content.windows.filter { $0.isOnScreen && $0.frame.width > 40 }
    let emulatorWindows = visible.filter {
      $0.owningApplication?.applicationName == emulatorApp
        && (options["emulator-title"] == nil
          || ($0.title ?? "").contains(options["emulator-title"]!))
    }
    guard
      let emulator = emulatorWindows.max(by: {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
      })
    else {
      fail("No on-screen window of \(emulatorApp) was found. Nothing was recorded.", code: 2)
    }
    let companionWindows = visible.filter {
      $0.owningApplication?.applicationName == companionApp
    }
    // Two running copies of the app (a preview build, say) share its name:
    // refuse rather than guess which one is the run.
    let companionProcesses = Set(companionWindows.compactMap { $0.owningApplication?.processID })
    guard companionProcesses.count <= 1 else {
      fail(
        "\(companionProcesses.count) running copies of \(companionApp) have windows on screen. Quit every copy but the one under test. Nothing was recorded.",
        code: 2)
    }
    var rule = "title"
    var companion = companionWindows.first { $0.title == companionTitle }
    if companion == nil {
      // The panel may not expose its title: take the app's smallest window.
      rule = "smallest window"
      companion = companionWindows.min(by: {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
      })
    }
    guard let companion, let emulatorOwner = emulator.owningApplication else {
      fail("No on-screen window of \(companionApp) was found. Nothing was recorded.", code: 2)
    }
    guard
      let display = content.displays.first(where: { $0.frame.intersects(emulator.frame) })
        ?? content.displays.first
    else { fail("No display was found.", code: 2) }

    let union = emulator.frame.union(companion.frame).intersection(display.frame)
    let crop = union.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    let pictureFilter = SCContentFilter(display: display, including: [emulator, companion])
    let scale = CGFloat(pictureFilter.pointPixelScale)
    let even = { (value: CGFloat) in max(2, Int((value * scale) / 2) * 2) }
    let width = even(crop.width)
    let height = even(crop.height)

    let picture = SCStreamConfiguration()
    picture.sourceRect = crop
    picture.width = width
    picture.height = height
    picture.showsCursor = false
    picture.capturesAudio = false
    picture.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    picture.queueDepth = 6

    // The sound: the emulator app alone. TalkQTE makes no sound, and no
    // other app is heard.
    let soundFilter = SCContentFilter(
      display: display, including: [emulatorOwner], exceptingWindows: [])
    let sound = SCStreamConfiguration()
    sound.capturesAudio = true
    sound.sampleRate = 48_000
    sound.channelCount = 2
    sound.excludesCurrentProcessAudio = true
    sound.width = 2
    sound.height = 2
    sound.minimumFrameInterval = CMTime(value: 1, timescale: 1)

    emit([
      "event": "matched",
      "emulator": [
        "app": emulatorApp, "windowId": Int(emulator.windowID),
        "frame": frameDictionary(emulator.frame),
      ],
      "companion": [
        "app": companionApp, "windowId": Int(companion.windowID), "rule": rule,
        "frame": frameDictionary(companion.frame),
      ],
      "picture": ["width": width, "height": height, "scale": Double(scale)],
    ])

    let writer: Writer
    do {
      writer = try Writer(url: URL(fileURLWithPath: out), width: width, height: height)
    } catch {
      fail("Could not write \(out): \(error.localizedDescription)")
    }
    let queue = DispatchQueue(label: "talkqte.lab.capture")
    let pictureStream = SCStream(filter: pictureFilter, configuration: picture, delegate: writer)
    let soundStream = SCStream(filter: soundFilter, configuration: sound, delegate: writer)
    do {
      try pictureStream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: queue)
      try soundStream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: queue)
      try await pictureStream.startCapture()
      try await soundStream.startCapture()
    } catch {
      fail("Could not start recording: \(error.localizedDescription)")
    }

    // Until the time is up, or Ctrl-C.
    nonisolated(unsafe) var interrupted = false
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let signals = [SIGINT, SIGTERM].map { number in
      let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
      source.setEventHandler { interrupted = true }
      source.resume()
      return source
    }
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline && !interrupted && writer.problem == nil {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    _ = signals

    try? await soundStream.stopCapture()
    try? await pictureStream.stopCapture()
    await withCheckedContinuation { continuation in
      queue.async {
        writer.video.markAsFinished()
        writer.audio.markAsFinished()
        continuation.resume()
      }
    }
    await writer.writer.finishWriting()
    emit([
      "event": "stopped", "wallMs": wallMs(), "frames": writer.frames,
      "audioBuffers": writer.audioBuffers,
      "status": writer.writer.status == .completed ? "completed" : "failed",
      "problem": writer.problem ?? writer.writer.error?.localizedDescription ?? "",
    ])
    if writer.writer.status != .completed || writer.frames == 0 { exit(1) }
  }
}
