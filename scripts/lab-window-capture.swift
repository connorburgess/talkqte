// Records exactly two windows, the meeting emulator's and the real TalkQTE
// companion's, with the emulator app's sound, using ScreenCaptureKit. It
// never records the whole screen: each window is captured on its own,
// independently of the active Space and of other windows covering it when a
// child probe shows macOS can do that for the window, and otherwise through
// a display filter limited to that one window. The two are composited at
// their on-screen positions into one picture.
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
  guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  else { return }
  // One write per line: a stream's stop is reported from macOS's own queue.
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

/// Ends the helper with a message for the person running it and a fixed
/// reason code. The message may name a path or carry macOS's own text, so
/// the recorder keeps only the reason.
func fail(_ message: String, code: Int32 = 1, reason: String) -> Never {
  emit(["event": "error", "reason": reason, "message": message])
  exit(code)
}

func wallMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

func parseArguments() -> [String: String] {
  var options: [String: String] = [:]
  var iterator = CommandLine.arguments.dropFirst().makeIterator()
  while let argument = iterator.next() {
    guard argument.hasPrefix("--") else { fail("Unknown argument \(argument).", code: 64, reason: "unknown-argument") }
    let key = String(argument.dropFirst(2))
    if ["check", "list", "capture", "strict-windows", "probe-window"].contains(key) {
      options[key] = "yes"
    } else if [
      "apps", "emulator-app", "emulator-title", "companion-app", "companion-title", "seconds",
      "out", "emulator-pid", "emulator-window-id", "companion-pid", "companion-window-id",
      "window-id", "owner-pid", "owner-app", "owner-bundle",
    ].contains(key) {
      guard let value = iterator.next() else { fail("\(argument) needs a value.", code: 64, reason: "missing-value") }
      options[key] = value
    } else {
      fail("Unknown argument \(argument).", code: 64, reason: "unknown-argument")
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

// Pure identity boundary, shared by refresh and the child probe. A reused
// window ID cannot widen the two selected owners; absent metadata fails closed.
struct LabWindowIdentity: Equatable {
  let windowID: UInt32
  let ownerPID: Int32
  let app: String
  let bundle: String

  init?(windowID: UInt32, ownerPID: Int32?, app: String?, bundle: String?) {
    guard windowID > 0, let ownerPID, ownerPID > 0,
      let app, !app.isEmpty, let bundle, !bundle.isEmpty else { return nil }
    self.windowID = windowID; self.ownerPID = ownerPID
    self.app = app; self.bundle = bundle
  }
}

func matchesSelectedWindow(_ expected: LabWindowIdentity?, _ actual: LabWindowIdentity?) -> Bool {
  guard let expected, let actual else { return false }
  return expected == actual
}

func windowIdentity(_ window: SCWindow) -> LabWindowIdentity? {
  LabWindowIdentity(windowID: window.windowID,
    ownerPID: window.owningApplication?.processID,
    app: window.owningApplication?.applicationName,
    bundle: window.owningApplication?.bundleIdentifier)
}

/// A window that can be captured: on screen, a finite size of at least 2x2,
/// and on at least one display.
func usableWindow(_ window: SCWindow, displays: [SCDisplay]) -> Bool {
  let f = window.frame
  return window.isOnScreen && f.width.isFinite && f.height.isFinite && f.width >= 2
    && f.height >= 2 && displays.contains(where: { $0.frame.intersects(f) })
}

/// Runs this program again in --probe-window mode, one child per window,
/// all at once, for up to one second in all. For each window, true only if
/// its child built the filter and exited 0. Both probes share the second so
/// the recorder's start deadline (3 s to the first accepted frame) holds.
func probeIndependentFilters(identities: [LabWindowIdentity]) -> [CGWindowID: Bool] {
  let windowIDs = identities.map { $0.windowID }
  let group = DispatchGroup()
  var children: [(CGWindowID, Process)] = []
  for identity in identities {
    let windowID = identity.windowID
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    child.arguments = ["--probe-window", "--window-id", String(windowID),
      "--owner-pid", String(identity.ownerPID), "--owner-app", identity.app,
      "--owner-bundle", identity.bundle]
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    group.enter()
    child.terminationHandler = { _ in group.leave() }
    do {
      try child.run()
      children.append((windowID, child))
    } catch {
      group.leave()
    }
  }
  if group.wait(timeout: .now() + 1) == .timedOut {
    for (_, child) in children where child.isRunning { child.terminate() }
  }
  var result: [CGWindowID: Bool] = [:]
  for windowID in windowIDs { result[windowID] = false }
  for (windowID, child) in children where !child.isRunning {
    result[windowID] = child.terminationReason == .exit && child.terminationStatus == 0
  }
  return result
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

  /// A stream macOS stopped (for example -3805, its connection
  /// interrupted) ends the recording; the error event says so with a fixed
  /// reason and macOS's numeric code, so the recorder knows why.
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let code = (error as NSError).code
    emit(["event": "error", "reason": "stream-stopped", "code": code,
      "message": error.localizedDescription])
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

#if LAB_WINDOW_IDENTITY_TESTS
// A pure-memory entrypoint: no permission check, window listing, filter or capture.
@main
struct WindowIdentityFixture {
  static func main() {
    func verify(_ condition: Bool) {
      if !condition { print("{\"checks\":0,\"passed\":false}"); exit(1) }
    }
    let expected = LabWindowIdentity(windowID: 41, ownerPID: 101,
      app: "Fictional Player", bundle: "org.example.fictional-player")
    let same = LabWindowIdentity(windowID: 41, ownerPID: 101,
      app: "Fictional Player", bundle: "org.example.fictional-player")
    verify(matchesSelectedWindow(expected, same))
    for foreign in [
      LabWindowIdentity(windowID: 41, ownerPID: 202, app: "Fictional Player", bundle: "org.example.fictional-player"),
      LabWindowIdentity(windowID: 41, ownerPID: 101, app: "Fictional Other", bundle: "org.example.fictional-player"),
      LabWindowIdentity(windowID: 41, ownerPID: 101, app: "Fictional Player", bundle: "org.example.fictional-other"),
      LabWindowIdentity(windowID: 42, ownerPID: 101, app: "Fictional Player", bundle: "org.example.fictional-player"),
      LabWindowIdentity(windowID: 41, ownerPID: nil, app: "Fictional Player", bundle: "org.example.fictional-player"),
      LabWindowIdentity(windowID: 41, ownerPID: 101, app: nil, bundle: "org.example.fictional-player"),
      LabWindowIdentity(windowID: 41, ownerPID: 101, app: "Fictional Player", bundle: nil),
    ] { verify(!matchesSelectedWindow(expected, foreign)) }
    verify(!matchesSelectedWindow(nil, nil))
    print("{\"checks\":9,\"passed\":true}")
  }
}
#else
@main
struct Capture {
  static func main() async {
    // Connect to the window server before any ScreenCaptureKit call: on
    // macOS 26.4 a desktop-independent window filter in a process that has
    // not done so aborts (CGS_REQUIRE_INIT), which failed every probe.
    _ = CGMainDisplayID()
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
        code: 77, reason: "screen-recording-not-allowed")
    }

    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(
        true, onScreenWindowsOnly: true)
    } catch {
      fail("Could not list windows: \(error.localizedDescription)", reason: "list-windows")
    }

    if options["list"] != nil {
      // Only the named apps' windows are listed, so nothing else of the
      // owner's appears.
      let apps = Set((options["apps"] ?? "").split(separator: ",").map(String.init))
      guard !apps.isEmpty else { fail("--list needs --apps.", code: 64, reason: "list-needs-apps") }
      let strictList = options["strict-windows"] != nil
      var ownedPids = Set<Int32>()
      if strictList {
        guard let playerPid = Int32(options["emulator-pid"] ?? ""), playerPid > 0,
          let nativePid = Int32(options["companion-pid"] ?? ""), nativePid > 0, playerPid != nativePid
        else { fail("Strict listing needs two exact owned process identities.", code: 64, reason: "strict-listing") }
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

    // A child of the capture run: build one desktop-independent filter for
    // one window and exit. Creating that filter can abort inside macOS
    // (RunB08), which no Swift code can catch; probing it in a child keeps
    // the capture alive and lets it fall back to a display filter.
    if options["probe-window"] != nil {
      guard let id = UInt32(options["window-id"] ?? ""),
        let expected = LabWindowIdentity(windowID: id,
          ownerPID: Int32(options["owner-pid"] ?? ""),
          app: options["owner-app"], bundle: options["owner-bundle"])
      else {
        fail("--probe-window needs an exact selected owner.", code: 64, reason: "probe-needs-window")
      }
      guard let fresh = try? await SCShareableContent.excludingDesktopWindows(
        true, onScreenWindowsOnly: false),
        let window = fresh.windows.first(where: { $0.windowID == id }),
        matchesSelectedWindow(expected, windowIdentity(window)),
        usableWindow(window, displays: fresh.displays)
      else { exit(3) }
      _ = SCContentFilter(desktopIndependentWindow: window)
      emit(["event": "probe", "ok": true])
      exit(0)
    }

    guard options["capture"] != nil else {
      fail("Use --check, --list or --capture.", code: 64, reason: "mode")
    }
    guard let emulatorApp = options["emulator-app"], let out = options["out"],
      let secondsText = options["seconds"], let seconds = Double(secondsText), seconds > 0,
      seconds <= 1800
    else {
      fail("--capture needs --emulator-app, --out and --seconds (up to 1800).", code: 64, reason: "capture-arguments")
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
      else { fail("Strict recording window identities are unavailable. Nothing was recorded.", code: 2, reason: "strict-identities") }
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
        fail("No on-screen window of \(emulatorApp) was found. Nothing was recorded.", code: 2, reason: "emulator-window-not-found")
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
          code: 2, reason: "companion-copies")
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
        fail("No on-screen window of \(companionApp) was found. Nothing was recorded.", code: 2, reason: "companion-window-not-found")
      }
      companion = selectedCompanion
    }
    guard let emulatorOwner = emulator.owningApplication else {
      fail("The selected emulator has no owner. Nothing was recorded.", code: 2, reason: "emulator-owner")
    }
    guard
      let display = content.displays.first(where: { $0.frame.intersects(emulator.frame) })
        ?? content.displays.first
    else { fail("No display was found.", code: 2, reason: "no-display") }

    // Each window on its own, wherever it is: not limited to the active
    // Space and not hidden by other windows.
    guard let emulatorSelected = windowIdentity(emulator),
      let companionSelected = windowIdentity(companion)
    else { fail("A selected window has no exact owner. Nothing was recorded.", code: 2, reason: "window-owner") }
    let probed = probeIndependentFilters(identities: [emulatorSelected, companionSelected])
    // Each window gets a desktop-independent filter (not limited to the
    // active Space) only if a child probe built one cleanly just now;
    // otherwise a display filter that includes that one window only, cropped
    // to it. Creating the independent filter for the TalkQTE companion bar
    // aborted inside macOS in RunB08 (SkyLight SLGetDisplaysWithRect
    // assert). Either way nothing but the two windows can appear. The window
    // list is re-read just before, so a moving or hidden window is not
    // filtered with a stale rectangle. It is re-read after the probe
    // children have exited: a stream started right after a child that used
    // ScreenCaptureKit exits is stopped by macOS within milliseconds (-3805,
    // connection interrupted), and this round trip waits that out.
    guard let fresh = try? await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: false)
    else { fail("Could not list windows again.", code: 2, reason: "relist-windows") }
    func currentWindow(_ window: SCWindow) -> (SCWindow, SCDisplay) {
      guard let current = fresh.windows.first(where: { $0.windowID == window.windowID }),
        matchesSelectedWindow(windowIdentity(window), windowIdentity(current)),
        usableWindow(current, displays: fresh.displays),
        let onDisplay = fresh.displays.first(where: { $0.frame.intersects(current.frame) })
      else {
        fail("A selected window is no longer usable (hidden, moving or off every display). Nothing was recorded.", code: 2, reason: "window-unusable")
      }
      return (current, onDisplay)
    }
    let (emulatorNow, emulatorOnDisplay) = currentWindow(emulator)
    let (companionNow, companionOnDisplay) = currentWindow(companion)
    func chooseFilter(_ current: SCWindow, on onDisplay: SCDisplay) -> (
      SCContentFilter, String, SCDisplay?
    ) {
      if probed[current.windowID] == true {
        return (SCContentFilter(desktopIndependentWindow: current), "independent", nil)
      }
      return (SCContentFilter(display: onDisplay, including: [current]), "display", onDisplay)
    }
    let (emulatorFilter, emulatorKind, emulatorDisplay) = chooseFilter(
      emulatorNow, on: emulatorOnDisplay)
    let (companionFilter, companionKind, companionDisplay) = chooseFilter(
      companionNow, on: companionOnDisplay)
    // From here on, sizes, crops, placement and the canvas use the windows as
    // just re-read, not as first selected. The canvas is their union,
    // whichever displays they are on.
    let union = emulatorNow.frame.union(companionNow.frame)
    let scale = CGFloat(emulatorFilter.pointPixelScale)
    let even = { (value: CGFloat) in max(2, Int((value * scale) / 2) * 2) }
    let width = even(union.width)
    let height = even(union.height)
    // Windows far apart (for example on two displays) make a canvas the
    // H.264 encoder cannot take; refuse before recording rather than fail
    // part-way. Keep both windows on one display.
    guard width <= 8192 && height <= 8192 else {
      fail("The two windows are too far apart to record together. Put both on one display.", code: 2, reason: "canvas-too-large")
    }
    func windowConfiguration(_ window: SCWindow, display: SCDisplay? = nil) -> SCStreamConfiguration {
      let configuration = SCStreamConfiguration()
      // A display filter is cropped to the window's own rectangle.
      if let display {
        configuration.sourceRect = window.frame.offsetBy(
          dx: -display.frame.minX, dy: -display.frame.minY)
      }
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
        "frame": frameDictionary(emulatorNow.frame),
      ],
      "companion": [
        "app": companionApp, "windowId": Int(companion.windowID), "rule": rule,
        "pid": Int(companion.owningApplication?.processID ?? 0),
        "frame": frameDictionary(companionNow.frame),
      ],
      "picture": ["width": width, "height": height, "scale": Double(scale)],
    ])
    // Which filter each window got, with what the helper saw of it.
    emit([
      "event": "filters",
      "emulator": [
        "kind": emulatorKind, "frame": frameDictionary(emulatorNow.frame),
        "layer": emulatorNow.windowLayer, "onScreen": emulatorNow.isOnScreen,
      ],
      "companion": [
        "kind": companionKind, "frame": frameDictionary(companionNow.frame),
        "layer": companionNow.windowLayer, "onScreen": companionNow.isOnScreen,
      ],
    ])

    let writer: Writer
    do {
      writer = try Writer(url: URL(fileURLWithPath: out), width: width, height: height,
        strictWindows: strictWindows)
    } catch {
      fail("Could not write \(out): \(error.localizedDescription)", reason: "output-write")
    }
    let queue = DispatchQueue(label: "talkqte.lab.capture")
    let emulatorStream = SCStream(
      filter: emulatorFilter, configuration: windowConfiguration(emulatorNow, display: emulatorDisplay),
      delegate: writer)
    let companionStream = SCStream(
      filter: companionFilter,
      configuration: windowConfiguration(companionNow, display: companionDisplay), delegate: writer)
    let soundStream = SCStream(filter: soundFilter, configuration: sound, delegate: writer)
    queue.sync {
      writer.place(emulatorStream, at: placeOf(emulatorNow))
      writer.place(companionStream, at: placeOf(companionNow))
    }
    do {
      try emulatorStream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: queue)
      try companionStream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: queue)
      try soundStream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: queue)
      try await emulatorStream.startCapture()
      try await companionStream.startCapture()
      try await soundStream.startCapture()
    } catch {
      fail("Could not start recording: \(error.localizedDescription)", reason: "start-capture")
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
      for start in [emulatorNow, companionNow] {
        guard let current = now.windows.first(where: { $0.windowID == start.windowID }),
          matchesSelectedWindow(windowIdentity(start), windowIdentity(current))
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

#endif
