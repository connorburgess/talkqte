// Approved fictional media, owned AppKit window and actual audio-render clock.
// The media sha256 is approved per run (third argument); the file is still
// hashed before use and the compiled 105 s ceiling still bounds its duration.
// Build with lab-player-state.c; no network, microphone or desktop automation.
import AppKit
import AVFoundation
import AudioToolbox
import CryptoKit
import Darwin

private let schema = "talkqte.lab.player.v1"
private func isApprovedHashText(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
}
private enum PlayerError: Error { case invalid }
private struct PreparationFailure: Error {
    let stage: String
    let decodedFrames: Int64
    let audioTrackDurationMs: Double
    let assetDurationMs: Double
}
private func require(_ condition: Bool) throws { if !condition { throw PlayerError.invalid } }

// Bit-preserving layout conversion only: no mixing, resampling or padding.
private func copyStereoPlanar(_ source: UnsafeRawBufferPointer, _ planes: [UnsafeMutableRawBufferPointer], _ frames: Int) throws {
    try require(frames > 0 && frames <= 105 * 48000 && source.count == frames * 8 &&
                planes.count == 2 && planes.allSatisfy { $0.count == frames * 4 })
    guard let input = source.baseAddress, let left = planes[0].baseAddress, let right = planes[1].baseAddress else { throw PlayerError.invalid }
    for frame in 0..<frames {
        left.advanced(by: frame * 4).copyMemory(from: input.advanced(by: frame * 8), byteCount: 4)
        right.advanced(by: frame * 4).copyMemory(from: input.advanced(by: frame * 8 + 4), byteCount: 4)
    }
}

// Dedicated bounded stdin reader; a short read is consumed immediately, never filled to 4096.
private func readLabPlayerCommands(_ fd: Int32, _ runId: String, approvedHash: String,
    readBytes: (Int32, UnsafeMutableRawPointer, Int) -> Int = { Darwin.read($0, $1, $2) },
    progress: (String, String, Int, Int) -> Void,
    stopReceived: () -> Void = {},
    command: (String, [String: Any], Int, Int) -> Void) {
    var buffer = [UInt8](repeating: 0, count: 4096), partial = Data()
    var total = 0, commands = 0, reportedRead = false
    do {
        while true {
            let n = buffer.withUnsafeMutableBytes { readBytes(fd, $0.baseAddress!, $0.count) }
            if n < 0 {
                if errno == EINTR { continue }
                progress("read-error", "none", commands, total); return
            }
            if n == 0 { progress(partial.isEmpty ? "eof" : "protocol-error", "none", commands, total); return }
            try require(n <= buffer.count && total + n <= 4 * 16384)
            total += n
            if !reportedRead { progress("read", "none", 0, total); reportedRead = true }
            partial.append(contentsOf: buffer.prefix(n))
            while let end = partial.firstIndex(of: 10) {
                try require(end + 1 <= 16384 && commands < 4)
                let line = partial.subdata(in: 0..<end); partial.removeSubrange(0...end)
                let raw = try JSONSerialization.jsonObject(with: line)
                guard let value = raw as? [String: Any], let type = value["type"] as? String,
                      ["clock_probe", "start", "stop", "retire"].contains(type) else { throw PlayerError.invalid }
                let keys = type == "clock_probe" ? ["schema","type","runId","generation","mediaSha256","probeId"] : ["schema","type","runId","generation","mediaSha256"]
                guard let text = String(data: line, encoding: .utf8) else { throw PlayerError.invalid }
                let matcher = try NSRegularExpression(pattern: "\"[^\"\\\\]*\"\\s*:")
                try require(matcher.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)) == value.count)
                try require(Set(value.keys) == Set(keys) && value["schema"] as? String == schema && value["runId"] as? String == runId && value["generation"] as? String == "1" && value["mediaSha256"] as? String == approvedHash)
                if type == "clock_probe" {
                    guard let probe = value["probeId"] as? String,
                          probe.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else { throw PlayerError.invalid }
                }
                commands += 1
                if type == "stop" { stopReceived() } // Latch before diagnostics or owner-queue dispatch.
                progress("parsed", type, commands, total)
                command(type, value, commands, total)
            }
            try require(partial.count < 16384)
        }
    } catch { progress("protocol-error", "none", commands, total) }
}

// One-way handoff: decoder never touches these objects after returning them;
// only the main owner queue may use/mutate them after the handoff.
private final class DecodedMedia: @unchecked Sendable {
    let pcm: AVAudioPCMBuffer
    let video: AVMutableComposition
    let audioTrackDurationMs: Double
    let assetDurationMs: Double
    init(_ pcm: AVAudioPCMBuffer, _ video: AVMutableComposition, _ audioMs: Double, _ assetMs: Double) {
        self.pcm = pcm; self.video = video; self.audioTrackDurationMs = audioMs; self.assetDurationMs = assetMs
    }
}
final class LabPlayer: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let runId: String
    let mediaURL: URL
    let approvedHash: String
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
    var probeOffset: (low: Int64, high: Int64)?
    var first: (ticks: UInt64, sample: Int64)?
    var anchor: UInt64?
    var maximumSample: Int64 = 0
    var timebase = mach_timebase_info_data_t()
    var topology: (Double, AVAudioChannelCount, AudioDeviceID)?
    var failed = false
    var startRequested = false
    var audioTrackDurationMs: Double = 0
    var assetDurationMs: Double = 0
    var diagnosticStage = "prepare"
    var diagnosticFrames: Int64 = 0
    var audioCompleted = false
    var videoCompleted = false
    var videoObserver: NSObjectProtocol?
    let outputLock = NSLock()

    init(runId: String, path: String, approvedHash: String) throws {
        try require(runId.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil)
        try require(isApprovedHashText(approvedHash))
        self.approvedHash = approvedHash
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
        // Owner/control worker only; never an audio callback. Keep JSON lines atomic.
        var packet = data; packet.append(10)
        outputLock.lock(); defer { outputLock.unlock() }
        FileHandle.standardOutput.write(packet)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        publishPreparationProgress("launch")
        installInput()
        let preparation = DispatchWorkItem { [weak self] in self?.stop(failure: true) }
        watchdog = preparation
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: preparation)
        Task.detached(priority: .userInitiated) {
            do {
                let decoded = try await self.decode()
                await MainActor.run { self.prepared(decoded) }
            } catch {
                let failure = error as? PreparationFailure
                await MainActor.run {
                    if let failure = failure {
                        self.diagnosticStage = failure.stage; self.diagnosticFrames = failure.decodedFrames
                        self.audioTrackDurationMs = failure.audioTrackDurationMs; self.assetDurationMs = failure.assetDurationMs
                    }
                    self.stop(failure: true)
                }
            }
        }
    }
    func publishPreparationProgress(_ stage: String, _ decodedFrames: Int64 = 0, _ audioMs: Double = 0, _ assetMs: Double = 0) {
        guard phase == "preparing", lab_player_stopped(state) == 0 else { return }
        diagnosticStage = stage; diagnosticFrames = decodedFrames
        audioTrackDurationMs = audioMs; assetDurationMs = assetMs
        emit("preparation_progress", ["stage": stage, "decodedFrames": decodedFrames,
             "audioTrackDurationMs": audioMs, "assetDurationMs": assetMs])
    }
    func preparationProgress(_ stage: String, _ decodedFrames: Int64 = 0, _ audioMs: Double = 0, _ assetMs: Double = 0) async {
        await MainActor.run { self.publishPreparationProgress(stage, decodedFrames, audioMs, assetMs) }
    }
    fileprivate func decode() async throws -> DecodedMedia {
        var stage = "media-identity"
        var count: Int64 = 0
        var audioMs: Double = 0
        var assetMs: Double = 0
        do {
        await preparationProgress(stage)
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
        stage = "track-timeline"
        await preparationProgress(stage, count, audioMs, assetMs)
        let asset = AVURLAsset(url: mediaURL)
        let assetDuration = try await asset.load(.duration)
        let duration = assetDuration.seconds
        try require(duration.isFinite && duration > 0 && duration <= 105)
        assetMs = duration * 1000
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let videos = try await asset.loadTracks(withMediaType: .video)
        try require(audio.count == 1 && videos.count == 1)
        let audioRange = try await audio[0].load(.timeRange)
        let audioDuration = audioRange.duration.seconds
        try require(audioRange.start.seconds.isFinite && abs(audioRange.start.seconds) <= 1.0 / 48000 &&
                    audioDuration.isFinite && audioDuration > 0 && audioDuration <= duration + 0.1)
        audioMs = audioDuration * 1000
        stage = "audio-decode"
        await preparationProgress(stage, count, audioMs, assetMs)
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = audioRange
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
        stage = "audio-duration"
        await preparationProgress(stage, count, audioMs, assetMs)
        try require(reader.status == .completed && count > 0 && abs(Double(count) / 48000 - audioDuration) <= 0.1)
        stage = "pcm-buffer"
        await preparationProgress(stage, count, audioMs, assetMs)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2),
              format.isStandard, !format.isInterleaved,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { throw PlayerError.invalid }
        buffer.frameLength = AVAudioFrameCount(count)
        let buffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        try require(buffers.count == 2 && buffers.allSatisfy { $0.mNumberChannels == 1 && Int($0.mDataByteSize) == Int(count) * 4 && $0.mData != nil })
        try bytes.withUnsafeBytes { raw in
            try copyStereoPlanar(raw, buffers.map { UnsafeMutableRawBufferPointer(start: $0.mData, count: Int($0.mDataByteSize)) }, Int(count))
        }
        stage = "video-composition"
        await preparationProgress(stage, count, audioMs, assetMs)
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw PlayerError.invalid }
        try track.insertTimeRange(CMTimeRange(start: .zero, duration: assetDuration), of: videos[0], at: .zero)
        track.preferredTransform = try await videos[0].load(.preferredTransform)
        try require(lab_player_stopped(state) == 0)
        return DecodedMedia(buffer, composition, audioMs, assetMs)
        } catch {
            throw PreparationFailure(stage: stage, decodedFrames: count, audioTrackDurationMs: audioMs, assetDurationMs: assetMs)
        }
    }
    fileprivate func prepared(_ decoded: DecodedMedia) {
        guard phase == "preparing", lab_player_stopped(state) == 0 else { return }
        pcm = decoded.pcm; format = decoded.pcm.format; frames = Int64(decoded.pcm.frameLength)
        diagnosticFrames = frames; audioTrackDurationMs = decoded.audioTrackDurationMs; assetDurationMs = decoded.assetDurationMs
        guard decoded.pcm.format.isStandard, !decoded.pcm.format.isInterleaved,
              decoded.pcm.format.sampleRate == 48000, decoded.pcm.format.channelCount == 2 else { return stop(failure: true) }
        publishPreparationProgress("engine-connect", frames, audioTrackDurationMs, assetDurationMs)
        engine.attach(node); engine.connect(node, to: engine.mainMixerNode, format: format)
        publishPreparationProgress("engine-prepare", frames, audioTrackDurationMs, assetDurationMs)
        engine.prepare() // Not started; no scheduled acknowledgement.
        let video = AVPlayer(playerItem: AVPlayerItem(asset: decoded.video))
        // Required by setRate(_:time:atHostTime:), including a past host anchor.
        video.automaticallyWaitsToMinimizeStalling = false
        video.isMuted = true; self.video = video
        videoObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: video.currentItem, queue: .main) { [weak self] _ in
            self?.observeVideoCompletion()
        }
        publishPreparationProgress("window-prepare", frames, audioTrackDurationMs, assetDurationMs)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 540), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Fictional generated meeting — TalkQTE Lab Player"
        window.delegate = self; window.center()
        let view = NSView(frame: window.contentView!.bounds); view.wantsLayer = true
        let layer = AVPlayerLayer(player: video); layer.frame = view.bounds; layer.videoGravity = .resizeAspect
        view.layer = layer; window.contentView = view; self.window = window
        publishPreparationProgress("video-seek", frames, audioTrackDurationMs, assetDurationMs)
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
                    self.publishPreparationProgress("window-visible", self.frames, self.audioTrackDurationMs, self.assetDurationMs)
                    self.watchdog?.cancel(); self.phase = "prepared"; self.diagnosticStage = "prepared"
                    self.emit("prepared", ["pid": getpid(), "windowId": window.windowNumber,
                        "application": "TalkQTE Lab Player", "bundleId": "com.talkqte.lab-player",
                        "processStart": ["seconds": String(seconds), "microseconds": microseconds],
                        "sampleRate": 48000, "channels": 2, "totalFrames": self.frames,
                        "durationMs": Double(self.frames) / 48, "audioTrackDurationMs": self.audioTrackDurationMs,
                        "assetDurationMs": self.assetDurationMs, "videoOnly": true, "pcmFormat": "float32-planar"])
                }
            }
        }
    }
    func transportProgress(_ step: String, _ type: String, _ index: Int, _ bytes: Int) {
        emit("transport_progress", ["step": step, "command": type, "commandIndex": index, "bytesRead": bytes])
    }
    func installInput() {
        DispatchQueue.global(qos: .userInitiated).async {
            readLabPlayerCommands(STDIN_FILENO, self.runId, approvedHash: self.approvedHash, progress: { step, type, index, bytes in
                self.transportProgress(step, type, index, bytes)
            }, stopReceived: { lab_player_latch_stop(self.state) }, command: { type, value, index, bytes in
                DispatchQueue.main.async {
                    self.transportProgress("applied", type, index, bytes)
                    self.control(type, value)
                }
            })
            lab_player_latch_stop(self.state)
            DispatchQueue.main.async { self.stop(failure: true) }
        }
    }
    func clockPair() throws -> (before: UInt64, continuous: UInt64, after: UInt64) {
        let before = mach_absolute_time()
        let continuous = mach_continuous_time()
        let after = mach_absolute_time()
        try require(after >= before)
        func delta(_ left: UInt64, _ right: UInt64) throws -> Int64 {
            let magnitude = left >= right ? left - right : right - left
            try require(magnitude <= UInt64(Int64.max))
            return left >= right ? Int64(magnitude) : -Int64(magnitude)
        }
        let low = try delta(continuous, after), high = try delta(continuous, before)
        if let offset = probeOffset {
            // Node/libuv uses continuous time; audio node host time is absolute.
            // Sleep changes their offset. Reject disjoint brackets, no repair.
            try require(low <= offset.high && high >= offset.low)
        }
        return (before, continuous, after)
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
            do {
                let pair = try clockPair()
                let low = pair.continuous >= pair.after ? Int64(pair.continuous - pair.after) : -Int64(pair.after - pair.continuous)
                let high = pair.continuous >= pair.before ? Int64(pair.continuous - pair.before) : -Int64(pair.before - pair.continuous)
                probeOffset = (low, high)
                emit("clock_sample", ["probeId": probe, "hostTicks": String(pair.continuous),
                    "absoluteBeforeTicks": String(pair.before), "absoluteAfterTicks": String(pair.after),
                    "timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom])
            } catch { stop(failure: true) }
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
        diagnosticStage = "start"
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
        if phase == "video-tail" {
            // C state 2 is the natural audio-completion claim; state 1 is Stop.
            guard lab_player_stopped(state) == 2 else { return stop(failure: false) }
            do { _ = try clockPair() } catch { stop(failure: true) }
            return
        }
        guard phase == "starting" || phase == "playing" else { return }
        guard lab_player_stopped(state) == 0 else { return stop(failure: false) }
        let pair: (before: UInt64, continuous: UInt64, after: UInt64)
        do { pair = try clockPair() } catch { return stop(failure: true) }
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
                anchor = zeroB; phase = "playing"; diagnosticStage = "render"
                video?.setRate(1, time: .zero, atHostTime: CMClockMakeHostTimeFromSystemUnits(zeroB))
                emit("started", ["sampleRate": 48000, "totalFrames": frames,
                    "observations": [["hostTicks": String(first.ticks), "sampleTime": String(first.sample), "hostTimeValid": true, "sampleTimeValid": true],
                                     ["hostTicks": String(render.hostTime), "sampleTime": String(sample), "hostTimeValid": true, "sampleTimeValid": true]],
                    "timebaseNumer": timebase.numer, "timebaseDenom": timebase.denom,
                    "clockPair": ["absoluteBeforeTicks": String(pair.before), "continuousTicks": String(pair.continuous), "absoluteAfterTicks": String(pair.after)],
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
            audioCompleted = true; phase = "video-tail"; diagnosticStage = "video-tail"
            node.stop(); engine.stop()
            guard !engine.isRunning else { return stop(failure: true) }
            emit("audio_completed", ["framesPlayed": frames, "observedSampleTime": String(maximumSample),
                                "callbackType": "dataPlayedBack", "engineRunning": false])
            finishIfCompleted()
        }
    }
    func observeVideoCompletion() {
        guard lab_player_stopped(state) != 1 else { return stop(failure: false) }
        guard !failed, lab_player_stopped(state) == (audioCompleted ? 2 : 0), anchor != nil,
              !videoCompleted, phase == "playing" || phase == "video-tail",
              let video = video else { return stop(failure: true) }
        do { _ = try clockPair() } catch { return stop(failure: true) }
        let timeMs = video.currentTime().seconds * 1000
        guard timeMs.isFinite, abs(timeMs - assetDurationMs) <= 100 else { return stop(failure: true) }
        videoCompleted = true
        emit("video_completed", ["videoTimeMs": timeMs, "assetDurationMs": assetDurationMs])
        finishIfCompleted()
    }
    func finishIfCompleted() {
        guard audioCompleted && videoCompleted && !failed && lab_player_stopped(state) == 2 else { return }
        phase = "completed"; diagnosticStage = "completed"; timer?.cancel(); watchdog?.cancel(); video?.pause()
        emit("completed", ["audioCompleted": true, "videoCompleted": true, "engineRunning": false])
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
        if let observer = videoObserver { NotificationCenter.default.removeObserver(observer); videoObserver = nil }
        phase = "stopped"
        if failed || engine.isRunning { emit("failed", ["code": "player_failed", "stage": diagnosticStage,
            "decodedFrames": min(max(diagnosticFrames, 0), 105 * 48000), "audioTrackDurationMs": audioTrackDurationMs, "assetDurationMs": assetDurationMs]) }
        emit("stopped", ["engineRunning": engine.isRunning, "completed": !failed && wasCompleted])
        // Keep process/window identity alive until the JS owner has independently
        // established native release and recording finalization, then retire.
        // Callback context/PCM stay alive until that owned process exit.
    }
}
#if LAB_PLAYER_PCM_TESTS
// Compiled during offline validation, not executed by the lab workflow.
func testStereoPlanarPreservation() throws {
    let words: [UInt32] = [0x3f800000, 0xbf800000, 0x00000000, 0x80000000, 0x7fc12345, 0x00000001]
    var left = [UInt32](repeating: 0xdeadbeef, count: 3)
    var right = left
    try words.withUnsafeBytes { input in
        try left.withUnsafeMutableBytes { l in
            try right.withUnsafeMutableBytes { r in try copyStereoPlanar(input, [l, r], 3) }
        }
    }
    precondition(left == [words[0], words[2], words[4]] && right == [words[1], words[3], words[5]])
    precondition(left.count == 3 && right.count == 3) // Exact frame count and channel order.
    var rejected = false
    do { try words.withUnsafeBytes { try copyStereoPlanar($0, [], 3) } } catch { rejected = true }
    precondition(rejected)
    rejected = false
    do { try words.withUnsafeBytes { input in
        try left.withUnsafeMutableBytes { l in
            try right.withUnsafeMutableBytes { r in try copyStereoPlanar(input, [l, r], 2) }
        }
    } } catch { rejected = true }
    precondition(rejected) // Never silently truncate/pad a mismatching frame shape.
}
try testStereoPlanarPreservation()
#elseif LAB_PLAYER_INPUT_TESTS
let mode = CommandLine.arguments.count == 2 ? CommandLine.arguments[1] : "normal"
if !["normal", "read-error", "eintr"].contains(mode) { exit(2) }
func fixtureEmit(_ type: String, _ fields: [String: Any] = [:]) {
    var value = fields; value["type"] = type
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
fixtureEmit("fixture_ready")
if mode == "read-error" { Darwin.close(STDIN_FILENO) }
var interrupted = false
readLabPlayerCommands(STDIN_FILENO, "fictional-transport",
    approvedHash: "1faf1c404249bed069065f51262abfce6956fa8a31f237e68bb6e9d06cb893e2", readBytes: { fd, bytes, count in
    if mode == "eintr" && !interrupted { interrupted = true; errno = EINTR; return -1 }
    return Darwin.read(fd, bytes, count)
}, progress: { step, type, index, bytes in
    fixtureEmit("transport_progress", ["step": step, "command": type, "commandIndex": index, "bytesRead": bytes])
}, command: { type, _, index, _ in
    fixtureEmit("fixture_reply", ["command": type, "commandIndex": index])
})
#else
let arguments = CommandLine.arguments
if arguments.count != 4 { exit(1) }
do {
    let delegate = try LabPlayer(runId: arguments[1], path: arguments[2], approvedHash: arguments[3])
    let app = NSApplication.shared; app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
} catch { exit(1) }

#endif
