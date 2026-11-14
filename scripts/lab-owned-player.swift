// Fixed fictional media, owned AppKit window and actual audio-render clock.
// Build with lab-player-state.c; no network, microphone or desktop automation.
import AppKit
import AVFoundation
import AudioToolbox
import CryptoKit
import Darwin

private let schema = "talkqte.lab.player.v1"
private let approvedHash = "1faf1c404249bed069065f51262abfce6956fa8a31f237e68bb6e9d06cb893e2"
private enum PlayerError: Error { case invalid }
private func require(_ condition: Bool) throws { if !condition { throw PlayerError.invalid } }

// One-way handoff: decoder never touches these objects after returning them;
// only the main owner queue may use/mutate them after the handoff.
private final class DecodedMedia: @unchecked Sendable {
    let pcm: AVAudioPCMBuffer
    let video: AVMutableComposition
    init(_ pcm: AVAudioPCMBuffer, _ video: AVMutableComposition) { self.pcm = pcm; self.video = video }
}
final class LabPlayer: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let runId: String
    let mediaURL: URL
    let state: OpaquePointer
    let engine = AVAudioEngine()
    let node = AVAudioPlayerNode()
    var pcm: AVAudioPCMBuffer?
    var video: AVPlayer?
    var window: NSWindow?
    var timer: DispatchSourceTimer?
    var watchdog: DispatchWorkItem?
    var configObserver: NSObjectProtocol?
    var format: AVAudioFormat?
    var frames: Int64 = 0
    var phase = "preparing"
    var clockProbed = false
    var first: (ticks: UInt64, sample: Int64)?
    var anchor: UInt64?
    var maximumSample: Int64 = 0
    var timebase = mach_timebase_info_data_t()
    var topology: (Double, AVAudioChannelCount, AudioDeviceID)?
    var failed = false
    var startRequested = false

    init(runId: String, path: String) throws {
        try require(runId.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil)
        let url = URL(fileURLWithPath: path)
        try require(path.hasPrefix("/") && url.resolvingSymlinksInPath().path == path)
        self.runId = runId; self.mediaURL = url
        guard let state = lab_player_state_create() else { throw PlayerError.invalid }
        self.state = state
        super.init()
        try require(mach_timebase_info(&timebase) == KERN_SUCCESS && timebase.numer > 0 && timebase.denom > 0)
    }
    func emit(_ type: String, _ values: [String: Any] = [:]) {
        var value: [String: Any] = ["schema": schema, "type": type, "runId": runId,
                                  "generation": "1", "mediaSha256": approvedHash]
        for (key, item) in values { value[key] = item }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count < 16384 else {
            exit(1)
        }
        // Owner main queue only, never an audio completion/render callback.
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installInput()
        let preparation = DispatchWorkItem { [weak self] in self?.stop(failure: true) }
        watchdog = preparation
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: preparation)
        Task.detached(priority: .userInitiated) {
            do {
                let decoded = try await self.decode()
                await MainActor.run { self.prepared(decoded) }
            } catch { await MainActor.run { self.stop(failure: true) } }
        }
    }
    fileprivate func decode() async throws -> DecodedMedia {
        let values = try mediaURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey])
        try require(values.isRegularFile == true && values.isSymbolicLink != true && (values.fileSize ?? 0) > 0 && values.fileSize! <= 256 * 1024 * 1024)
        let handle = try FileHandle(forReadingFrom: mediaURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 65536), !chunk.isEmpty {
            try require(lab_player_stopped(state) == 0)
            hasher.update(data: chunk)
        }
        try require(hasher.finalize().map { String(format: "%02x", $0) }.joined() == approvedHash)
        let asset = AVURLAsset(url: mediaURL)
        let assetDuration = try await asset.load(.duration)
        let duration = assetDuration.seconds
        try require(duration.isFinite && duration > 0 && duration <= 105)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let videos = try await asset.loadTracks(withMediaType: .video)
        try require(audio.count == 1 && videos.count == 1)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: audio[0], outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false
        ])
        output.alwaysCopiesSampleData = false
        try require(reader.canAdd(output)); reader.add(output)
        try require(reader.startReading())
        var bytes = Data()
        var count: Int64 = 0
        while let sample = output.copyNextSampleBuffer() {
            try require(lab_player_stopped(state) == 0)
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            try require(pts.isFinite && abs(pts - Double(count) / 48000) <= 1.0 / 48000)
            let samples = CMSampleBufferGetNumSamples(sample)
            guard let block = CMSampleBufferGetDataBuffer(sample) else { throw PlayerError.invalid }
            let size = CMBlockBufferGetDataLength(block)
            try require(samples > 0 && size == samples * 8 && bytes.count + size <= 128 * 1024 * 1024)
            let old = bytes.count; bytes.count += size
            let status = bytes.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: raw.baseAddress!.advanced(by: old))
            }
            try require(status == kCMBlockBufferNoErr)
            count += Int64(samples)
            try require(count <= 105 * 48000)
        }
        try require(reader.status == .completed && count > 0 && abs(Double(count) / 48000 - duration) <= 0.1)
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: true),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { throw PlayerError.invalid }
        buffer.frameLength = AVAudioFrameCount(count)
        let list = buffer.mutableAudioBufferList
        try require(list.pointee.mNumberBuffers == 1 && Int(list.pointee.mBuffers.mDataByteSize) == bytes.count)
        _ = bytes.withUnsafeBytes { raw in memcpy(list.pointee.mBuffers.mData!, raw.baseAddress!, bytes.count) }
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw PlayerError.invalid }
        try track.insertTimeRange(CMTimeRange(start: .zero, duration: assetDuration), of: videos[0], at: .zero)
        track.preferredTransform = try await videos[0].load(.preferredTransform)
        try require(lab_player_stopped(state) == 0)
        return DecodedMedia(buffer, composition)
    }
    fileprivate func prepared(_ decoded: DecodedMedia) {
        guard phase == "preparing", lab_player_stopped(state) == 0 else { return }
        pcm = decoded.pcm; format = decoded.pcm.format; frames = Int64(decoded.pcm.frameLength)
        engine.attach(node); engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare() // Not started; no scheduled acknowledgement.
        let video = AVPlayer(playerItem: AVPlayerItem(asset: decoded.video)); video.isMuted = true; self.video = video
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 540), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Fictional generated meeting — TalkQTE Lab Player"
        window.delegate = self; window.center()
        let view = NSView(frame: window.contentView!.bounds); view.wantsLayer = true
        let layer = AVPlayerLayer(player: video); layer.frame = view.bounds; layer.videoGravity = .resizeAspect
        view.layer = layer; window.contentView = view; self.window = window
        video.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { success in
            DispatchQueue.main.async {
                guard self.phase == "preparing", lab_player_stopped(self.state) == 0 else { return }
                guard success else { return self.stop(failure: true) }
                window.makeKeyAndOrderFront(nil)
                DispatchQueue.main.async {
                    guard self.phase == "preparing", lab_player_stopped(self.state) == 0 else { return }
                    var seconds: UInt64 = 0, microseconds: UInt32 = 0
                    guard lab_player_process_start(getpid(), &seconds, &microseconds) == 1,
                          window.windowNumber > 0, window.isVisible,
                          Bundle.main.bundleIdentifier == "com.talkqte.lab-player" else { return self.stop(failure: true) }
                    self.watchdog?.cancel(); self.phase = "prepared"
                    self.emit("prepared", ["pid": getpid(), "windowId": window.windowNumber,
                        "application": "TalkQTE Lab Player", "bundleId": "com.talkqte.lab-player",
                        "processStart": ["seconds": String(seconds), "microseconds": microseconds],
                        "sampleRate": 48000, "channels": 2, "totalFrames": self.frames,
                        "durationMs": Double(self.frames) / 48, "videoOnly": true])
                }
            }
        }
    }
    func installInput() {
        DispatchQueue.global(qos: .userInitiated).async {
            var partial = Data()
            do {
                while let bytes = try FileHandle.standardInput.read(upToCount: 4096), !bytes.isEmpty {
                    partial.append(bytes)
                    if partial.count > 16384 { throw PlayerError.invalid }
                    while let end = partial.firstIndex(of: 10) {
                        let line = partial.subdata(in: 0..<end); partial.removeSubrange(0...end)
                        let raw = try JSONSerialization.jsonObject(with: line)
                        guard let value = raw as? [String: Any], let type = value["type"] as? String else { throw PlayerError.invalid }
                        let keys = type == "clock_probe" ? ["schema","type","runId","generation","mediaSha256","probeId"] : ["schema","type","runId","generation","mediaSha256"]
                        // Keys are fixed ASCII; lexical count also rejects duplicate keys.
                        let text = String(data: line, encoding: .utf8) ?? ""
                        let matcher = try NSRegularExpression(pattern: "\"[^\"\\\\]*\"\\s*:")
                        try require(matcher.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)) == value.count)
                        try require(Set(value.keys) == Set(keys) && value["schema"] as? String == schema && value["runId"] as? String == self.runId && value["generation"] as? String == "1" && value["mediaSha256"] as? String == approvedHash)
                        if type == "stop" { lab_player_latch_stop(self.state) }
                        DispatchQueue.main.async { self.control(type, value) }
                    }
                }
            } catch {}
            lab_player_latch_stop(self.state)
            DispatchQueue.main.async { self.stop(failure: true) }
        }
    }
    func control(_ type: String, _ value: [String: Any]) {
        if type == "retire", phase == "stopped", !engine.isRunning {
            window?.orderOut(nil)
            exit(failed ? 1 : 0)
        }
        if lab_player_stopped(state) != 0 { return stop(failure: type != "stop") }
        if type == "clock_probe", phase == "prepared", !clockProbed,
           let probe = value["probeId"] as? String, probe.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil {
            clockProbed = true
            let ticks = mach_absolute_time()
            emit("clock_sample", ["probeId": probe, "hostTicks": String(ticks), "timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom])
        } else if type == "start", phase == "prepared", clockProbed, !startRequested {
            startRequested = true
            do { try start() } catch { stop(failure: true) }
        } else { stop(failure: true) }
    }
    func outputDevice() throws -> AudioDeviceID {
        guard let unit = engine.outputNode.audioUnit else { throw PlayerError.invalid }
        var device: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        try require(AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &device, &size) == noErr && device > 0 &&
            size == MemoryLayout<AudioDeviceID>.size)
        return device
    }
    func start() throws {
        try require(lab_player_stopped(state) == 0)
        guard let pcm = pcm else { throw PlayerError.invalid }
        let output = engine.outputNode.outputFormat(forBus: 0)
        try require(output.sampleRate.isFinite && output.sampleRate > 0 && output.channelCount > 0)
        topology = (output.sampleRate, output.channelCount, try outputDevice())
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in self?.stop(failure: true) }
        let flag = state // C atomic storage retained to process exit, including after Stop.
        node.scheduleBuffer(pcm, completionCallbackType: .dataPlayedBack) { type in
            lab_player_completed(flag, Int32(type.rawValue))
        }
        try engine.start(); phase = "starting"; node.play()
        let deadline = DispatchWorkItem { [weak self] in self?.stop(failure: true) }
        watchdog = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 110, execute: deadline)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(5))
        timer.setEventHandler { [weak self] in self?.observeRender() }
        self.timer = timer; timer.resume()
    }
    func observeRender() {
        guard phase == "starting" || phase == "playing" else { return }
        guard lab_player_stopped(state) == 0 else { return stop(failure: false) }
        let output = engine.outputNode.outputFormat(forBus: 0)
        guard engine.isRunning, output.sampleRate == topology?.0, output.channelCount == topology?.1,
              (try? outputDevice()) == topology?.2 else { return stop(failure: true) }
        guard let render = node.lastRenderTime, render.isHostTimeValid, render.isSampleTimeValid,
              let played = node.playerTime(forNodeTime: render), played.isSampleTimeValid,
              played.sampleRate == 48000, played.sampleTime >= 0 else { return }
        let sample = played.sampleTime
        if sample < maximumSample { return stop(failure: true) }
        maximumSample = sample
        if sample > 0 && anchor == nil {
            if let first = first {
                guard render.hostTime > first.ticks, sample > first.sample else { return }
                let a = AVAudioTime.hostTime(forSeconds: Double(first.sample) / 48000)
                let b = AVAudioTime.hostTime(forSeconds: Double(sample) / 48000)
                guard first.ticks >= a, render.hostTime >= b else { return stop(failure: true) }
                let zeroA = first.ticks - a, zeroB = render.hostTime - b
                let spread = AVAudioTime.seconds(forHostTime: max(zeroA, zeroB) - min(zeroA, zeroB)) * 1000
                guard spread.isFinite, spread <= 5 else { return stop(failure: true) }
                anchor = zeroB; phase = "playing"
                video?.setRate(1, time: .zero, atHostTime: CMClockMakeHostTimeFromSystemUnits(zeroB))
                emit("started", ["sampleRate": 48000, "totalFrames": frames,
                    "observations": [["hostTicks": String(first.ticks), "sampleTime": String(first.sample), "hostTimeValid": true, "sampleTimeValid": true],
                                     ["hostTicks": String(render.hostTime), "sampleTime": String(sample), "hostTimeValid": true, "sampleTimeValid": true]],
                    "timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom,
                    "outputLatencyEstimateMs": engine.outputNode.outputPresentationLatency * 1000,
                    "outputSampleRate": output.sampleRate, "outputChannels": output.channelCount,
                    "outputDeviceId": topology!.2,
                    "hostTimeValid": true, "sampleTimeValid": true])
            } else { first = (render.hostTime, sample) }
        }
        let completion = lab_player_completion(state)
        if completion >= 0 {
            guard completion == Int32(AVAudioPlayerNodeCompletionCallbackType.dataPlayedBack.rawValue),
                  phase == "playing", anchor != nil, maximumSample >= frames,
                  lab_player_claim_completion(state) == 1 else { return stop(failure: true) }
            phase = "completed"; timer?.cancel(); watchdog?.cancel()
            video?.pause(); node.stop(); engine.stop()
            guard !engine.isRunning else { return stop(failure: true) }
            emit("completed", ["framesPlayed": frames, "observedSampleTime": String(maximumSample),
                                "callbackType": "dataPlayedBack", "engineRunning": false])
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { stop(failure: false); return false }
    func stop(failure: Bool) {
        guard phase != "stopped" else { return }
        let wasCompleted = phase == "completed"
        failed = failed || failure
        lab_player_latch_stop(state)
        timer?.cancel(); watchdog?.cancel(); video?.pause(); video?.replaceCurrentItem(with: nil)
        node.stop(); engine.stop()
        if let observer = configObserver { NotificationCenter.default.removeObserver(observer); configObserver = nil }
        phase = "stopped"
        if failed || engine.isRunning { emit("failed", ["code": "player_failed"]) }
        emit("stopped", ["engineRunning": engine.isRunning, "completed": !failed && wasCompleted])
        // Keep process/window identity alive until the JS owner has independently
        // established native release and recording finalization, then retire.
        // Callback context/PCM stay alive until that owned process exit.
    }
}
let arguments = CommandLine.arguments
if arguments.count != 3 { exit(1) }
do {
    let delegate = try LabPlayer(runId: arguments[1], path: arguments[2])
    let app = NSApplication.shared; app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
} catch { exit(1) }
