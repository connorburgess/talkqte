// Records exactly two windows, the meeting emulator's and the real TalkQTE
// companion's, with the emulator app's sound, using ScreenCaptureKit. It
// never records the whole screen: each window is captured on its own,
// independently of the active Space and of other windows covering it, and
// the two are composited at their on-screen positions into one picture.
// (A display filter showed only windows on the active Space, so a run
// recorded black whenever the operator's frontmost app was on another
// Space; RunB07.) The sound comes from the emulator app alone. If either
// window cannot be found it records nothing.
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
import CoreImage
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
    if ["check", "list", "capture", "strict-windows"].contains(key) {
      options[key] = "yes"
    } else if [
      "apps", "emulator-app", "emulator-title", "companion-app", "companion-title", "seconds",
      "out", "emulator-pid", "emulator-window-id", "companion-pid", "companion-window-id",
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
  let adaptor: AVAssetWriterInputPixelBufferAdaptor
  let audio: AVAssetWriterInput
  let width: Int
  let height: Int
  // Each window stream's place in the picture, in output pixels with a
  // top-left origin, and its latest complete frame. Touched only on the
  // capture queue.
  var places: [ObjectIdentifier: CGRect] = [:]
  // Drawing order, fixed: the emulator first, the TalkQTE companion last,
  // so the cue card is never hidden under the player where they overlap.
  var order: [ObjectIdentifier] = []
  var latest: [ObjectIdentifier: CVPixelBuffer] = [:]
  var lastTime = CMTime.invalid
  let context = CIContext(options: [.cacheIntermediates: false])
  var started = false
  var frames = 0
  var audioBuffers = 0
  var problem: String?
  let strictWindows: Bool
  var streamsStarted = false
  var frameReported = false

  func reportReady() {
    guard strictWindows && streamsStarted && frames > 0 && !frameReported && problem == nil
      && writer.status == .writing else { return }
    frameReported = true
    // Accepted by the writer, not yet a durable completed movie.
    emit(["event": "frame_accepted", "wallMs": wallMs(), "frames": frames])
  }

  init(url: URL, width: Int, height: Int, strictWindows: Bool = false) throws {
    self.strictWindows = strictWindows
    self.width = width
    self.height = height
    writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width,
        AVVideoHeightKey: height,
      ])
    video.expectsMediaDataInRealTime = true
    adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: video,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
      ])
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
        let status = SCFrameStatus(rawValue: raw), status == .complete,
        let image = CMSampleBufferGetImageBuffer(buffer),
        places[ObjectIdentifier(stream)] != nil
      else { return }
      latest[ObjectIdentifier(stream)] = image
      // The picture starts once both windows have delivered a frame; after
      // that each new frame of either window redraws both at their places.
      guard latest.count == places.count else { return }
      let time = buffer.presentationTimeStamp
      if lastTime.isValid && CMTimeCompare(time, lastTime) <= 0 { return }
      if !started {
        writer.startSession(atSourceTime: time)
        started = true
        if !strictWindows { emit(["event": "started", "wallMs": wallMs()]) }
      }
      guard video.isReadyForMoreMediaData, let pool = adaptor.pixelBufferPool else { return }
      var output: CVPixelBuffer?
      guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output) == kCVReturnSuccess,
        let output
      else { return }
      let extent = CGRect(x: 0, y: 0, width: width, height: height)
      var picture = CIImage(color: .black).cropped(to: extent)
      for key in order {
        guard let place = places[key], let frame = latest[key] else { continue }
        let source = CIImage(cvPixelBuffer: frame)
        // Core Image's origin is bottom-left; places are top-left.
        let sx = place.width / max(source.extent.width, 1)
        let sy = place.height / max(source.extent.height, 1)
        let placed = source
          .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
          .transformed(
            by: CGAffineTransform(
              translationX: place.minX, y: CGFloat(height) - place.maxY))
        picture = placed.composited(over: picture)
      }
      context.render(picture, to: output)
      if adaptor.append(output, withPresentationTime: time) {
        lastTime = time
        frames += 1
        reportReady()
      }
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

  /// Where `stream`'s window goes in the picture (output pixels, top-left).
  /// Windows are drawn in the order they are placed.
  func place(_ stream: SCStream, at rect: CGRect) {
    let key = ObjectIdentifier(stream)
    if places[key] == nil { order.append(key) }
    places[key] = rect
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
      let strictList = options["strict-windows"] != nil
      var ownedPids = Set<Int32>()
      if strictList {
        guard let playerPid = Int32(options["emulator-pid"] ?? ""), playerPid > 0,
          let nativePid = Int32(options["companion-pid"] ?? ""), nativePid > 0, playerPid != nativePid
        else { fail("Strict listing needs two exact owned process identities.", code: 64) }
        ownedPids = [playerPid, nativePid]
      }
      for window in content.windows
      where apps.contains(window.owningApplication?.applicationName ?? "")
        && (!strictList || ownedPids.contains(window.owningApplication?.processID ?? 0)) {
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
    let strictWindows = options["strict-windows"] != nil
    let emulator: SCWindow
    let companion: SCWindow
    var rule = "title"
    if strictWindows {
      guard let emulatorPid = Int32(options["emulator-pid"] ?? ""), emulatorPid > 0,
        let companionPid = Int32(options["companion-pid"] ?? ""), companionPid > 0,
        let emulatorId = UInt32(options["emulator-window-id"] ?? ""), emulatorId > 0,
        let companionId = UInt32(options["companion-window-id"] ?? ""), companionId > 0,
        emulatorId != companionId, emulatorPid != companionPid,
        let exactEmulator = visible.first(where: {
          $0.windowID == emulatorId && $0.owningApplication?.processID == emulatorPid
            && $0.owningApplication?.applicationName == emulatorApp
        }),
        let exactCompanion = visible.first(where: {
          $0.windowID == companionId && $0.owningApplication?.processID == companionPid
            && $0.owningApplication?.applicationName == companionApp
        })
      else { fail("Strict recording window identities are unavailable. Nothing was recorded.", code: 2) }
      emulator = exactEmulator
      companion = exactCompanion
      rule = "exact pid/window"
    } else {
      let emulatorWindows = visible.filter {
        $0.owningApplication?.applicationName == emulatorApp
          && (options["emulator-title"] == nil
            || ($0.title ?? "").contains(options["emulator-title"]!))
      }
      guard
        let selectedEmulator = emulatorWindows.max(by: {
          $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        })
      else {
        fail("No on-screen window of \(emulatorApp) was found. Nothing was recorded.", code: 2)
      }
      emulator = selectedEmulator
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
      var selectedCompanion = companionWindows.first { $0.title == companionTitle }
      if selectedCompanion == nil {
        // The panel may not expose its title: take the app's smallest window.
        rule = "smallest window"
        selectedCompanion = companionWindows.min(by: {
          $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        })
      }
      guard let selectedCompanion else {
        fail("No on-screen window of \(companionApp) was found. Nothing was recorded.", code: 2)
      }
      companion = selectedCompanion
    }
    guard let emulatorOwner = emulator.owningApplication else {
      fail("The selected emulator has no owner. Nothing was recorded.", code: 2)
    }
    guard
      let display = content.displays.first(where: { $0.frame.intersects(emulator.frame) })
        ?? content.displays.first
    else { fail("No display was found.", code: 2) }

    // The canvas is the two windows' union, whichever displays they are on.
    let union = emulator.frame.union(companion.frame)
    // Each window on its own, wherever it is: not limited to the active
    // Space and not hidden by other windows.
    let emulatorFilter = SCContentFilter(desktopIndependentWindow: emulator)
    let companionFilter = SCContentFilter(desktopIndependentWindow: companion)
    let scale = CGFloat(emulatorFilter.pointPixelScale)
    let even = { (value: CGFloat) in max(2, Int((value * scale) / 2) * 2) }
    let width = even(union.width)
    let height = even(union.height)
    // Windows far apart (for example on two displays) make a canvas the
    // H.264 encoder cannot take; refuse before recording rather than fail
    // part-way. Keep both windows on one display.
    guard width <= 8192 && height <= 8192 else {
      fail("The two windows are too far apart to record together. Put both on one display.", code: 2)
    }
    func windowConfiguration(_ window: SCWindow) -> SCStreamConfiguration {
      let configuration = SCStreamConfiguration()
      configuration.width = even(window.frame.width)
      configuration.height = even(window.frame.height)
      configuration.showsCursor = false
      configuration.capturesAudio = false
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
      configuration.queueDepth = 6
      configuration.pixelFormat = kCVPixelFormatType_32BGRA
      return configuration
    }
    func placeOf(_ window: SCWindow) -> CGRect {
      CGRect(
        x: (window.frame.minX - union.minX) * scale,
        y: (window.frame.minY - union.minY) * scale,
        width: CGFloat(even(window.frame.width)),
        height: CGFloat(even(window.frame.height)))
    }

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
        "pid": Int(emulator.owningApplication?.processID ?? 0),
        "frame": frameDictionary(emulator.frame),
      ],
      "companion": [
        "app": companionApp, "windowId": Int(companion.windowID), "rule": rule,
        "pid": Int(companion.owningApplication?.processID ?? 0),
        "frame": frameDictionary(companion.frame),
      ],
      "picture": ["width": width, "height": height, "scale": Double(scale)],
    ])

    let writer: Writer
    do {
      writer = try Writer(url: URL(fileURLWithPath: out), width: width, height: height,
        strictWindows: strictWindows)
    } catch {
      fail("Could not write \(out): \(error.localizedDescription)")
    }
    let queue = DispatchQueue(label: "talkqte.lab.capture")
    let emulatorStream = SCStream(
      filter: emulatorFilter, configuration: windowConfiguration(emulator), delegate: writer)
    let companionStream = SCStream(
      filter: companionFilter, configuration: windowConfiguration(companion), delegate: writer)
    let soundStream = SCStream(filter: soundFilter, configuration: sound, delegate: writer)
    queue.sync {
      writer.place(emulatorStream, at: placeOf(emulator))
      writer.place(companionStream, at: placeOf(companion))
    }
    do {
      try emulatorStream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: queue)
      try companionStream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: queue)
      try soundStream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: queue)
      try await emulatorStream.startCapture()
      try await companionStream.startCapture()
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
    // Strict readiness also means ordinary Stop handlers are installed.
    queue.async {
      writer.streamsStarted = true
      writer.reportReady()
    }
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline && !interrupted && writer.problem == nil {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    _ = signals

    try? await soundStream.stopCapture()
    try? await emulatorStream.stopCapture()
    try? await companionStream.stopCapture()
    // Positions are taken once at the start. Report whether either window
    // moved or changed size since, so a misplaced picture is known.
    var windowsMoved = false
    var windowsResized = false
    var windowsMissing = false
    if let now = try? await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: false)
    {
      for start in [emulator, companion] {
        guard let current = now.windows.first(where: { $0.windowID == start.windowID })
        else {
          windowsMissing = true
          continue
        }
        if current.frame.origin != start.frame.origin { windowsMoved = true }
        if current.frame.size != start.frame.size { windowsResized = true }
      }
    }
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
      "windowsMoved": windowsMoved, "windowsResized": windowsResized,
      "windowsMissing": windowsMissing,
      "status": writer.writer.status == .completed ? "completed" : "failed",
      "problem": writer.problem ?? writer.writer.error?.localizedDescription ?? "",
    ])
    if writer.writer.status != .completed || writer.frames == 0 { exit(1) }
  }
}
