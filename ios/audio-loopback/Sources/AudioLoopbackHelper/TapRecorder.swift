import AudioLoopbackCore
import CoreAudio
import Foundation
import os

/// Records one iOS Simulator's output to stdout with a Core Audio process tap (#19046). The tap covers
/// the device's current audio clients; a running tap's process list cannot change, so the tap and its
/// aggregate are rebuilt whenever a client starts or stops. A tap delivers frames only while a tapped
/// process is playing, so once no frames have arrived for `lagMs` the output is padded with silence up
/// to the wall clock: a capture always has its full duration, and quiet stretches keep their length.
/// All mutable state is touched only on `queue`. The IOProc runs on its own `ioQueue`: stopping the
/// aggregate waits for a running IOProc, so sharing one serial queue would deadlock a rebuild.
final class TapRecorder: @unchecked Sendable {
    private static let tickMs = 20
    /// How long the tap may go without delivering before silence fills the gap; covers tap start-up and
    /// IO buffering, so a playing device is never padded mid-stream.
    private static let lagMs = 150
    /// The process tree does not notify; this re-check catches a client the HAL listener missed.
    private static let recheckTicks = 25

    private struct ActiveTap {
        let tapID: AudioObjectID
        let aggregateID: AudioObjectID
        let procID: AudioDeviceIOProcID
        let clients: [AudioObjectID: Int32]
    }

    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.audio-loopback.tap")
    private let ioQueue = DispatchQueue(label: "dev.jasonpearson.automobile.audio-loopback.tap-io")
    private let output = FileHandle.standardOutput
    private let launchdPid: Int32
    private let sampleRate: Int
    private let mute: Bool
    private let finished: @Sendable (Int32) -> Void
    private var remainingFrames: Int
    private var active: ActiveTap?
    private var resampler: MonoResampler?
    private var generation = 0
    private var startNanos: UInt64 = 0
    private var framesWritten = 0
    /// When the tap last delivered frames, or was (re)built. Written by the IOProc as it delivers, not
    /// when `queue` gets to the frames: a stdout write blocked on a slow reader must not look like a
    /// quiet device and get silence inserted ahead of audio already captured.
    private let lastTapNanos = OSAllocatedUnfairLock(initialState: UInt64(0))
    private var ticks = 0
    private var ticker: DispatchSourceTimer?
    private var listener: AudioObjectPropertyListenerBlock?
    private var done = false
    /// No duration: the capture runs until stdin closes.
    private let openEnded: Bool

    init(
        launchdPid: Int32,
        sampleRate: Int,
        durationMs: Int?,
        mute: Bool,
        finished: @escaping @Sendable (Int32) -> Void
    ) {
        self.launchdPid = launchdPid
        self.sampleRate = sampleRate
        self.mute = mute
        self.finished = finished
        remainingFrames = durationMs.map { $0 * sampleRate / 1000 } ?? Int.max
        openEnded = durationMs == nil
    }

    func start() throws {
        guard SimulatorAudioClients.isRunning(launchdPid) else {
            throw LoopbackError(.noSimulator, "No process \(launchdPid) is running, so the simulator is not booted.")
        }
        let permission = AudioCapturePermission.state()
        try queue.sync {
            startNanos = DispatchTime.now().uptimeNanoseconds
            try rebuild(clients: SimulatorAudioClients.current(launchdPid: launchdPid))
            watchClients()
            startTicker()
            // Installed only after startNanos is set: an immediate EOF flushes the quiet tail from
            // the capture start, not from host uptime.
            if openEnded {
                stopWhenStdinCloses()
            }
            LoopbackMain.report(LoopbackMarker.ready(
                deviceName: "process tap of launchd_sim \(launchdPid) (\(active?.clients.count ?? 0) clients, "
                    + "System Audio Recording \(permission))"
            ))
        }
    }

    private func stopWhenStdinCloses() {
        DispatchQueue.global().async { [self] in
            _ = try? FileHandle.standardInput.readToEnd()
            queue.async { [self] in
                finishFlushingQuietTail()
            }
        }
    }

    private func watchClients() {
        var property = Self.processListAddress
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.refresh()
        }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &property, queue, block)
            == noErr
        {
            listener = block
        }
    }

    private func startTicker() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(Self.tickMs))
        timer.setEventHandler { [weak self] in
            self?.tick()
        }
        timer.resume()
        ticker = timer
    }

    /// Pads silence when the output trails the wall clock, and periodically re-checks the clients.
    private func tick() {
        guard !done else {
            return
        }
        ticks += 1
        if ticks.isMultiple(of: Self.recheckTicks) {
            refresh()
        }
        let now = DispatchTime.now().uptimeNanoseconds
        let lastTap = lastTapNanos.withLock { $0 }
        guard active == nil || now < lastTap || Int((now - lastTap) / 1_000_000) > Self.lagMs else {
            return
        }
        padSilence(lagMs: Self.lagMs)
    }

    /// Writes the silence owed up to now, minus the newest `lagMs`.
    private func padSilence(lagMs: Int) {
        let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000)
        let due = SilenceFill.dueFrames(
            elapsedMs: elapsedMs, lagMs: lagMs, sampleRate: sampleRate, framesWritten: framesWritten
        )
        if due > 0 {
            write([Float](repeating: 0, count: due))
        }
    }

    /// A stop (stdin closed) keeps the whole capture: the quiet tail `lagMs` withholds is silence, not loss.
    private func finishFlushingQuietTail() {
        guard !done else {
            return
        }
        padSilence(lagMs: 0)
        finish(code: 0)
    }

    private func refresh() {
        guard !done else {
            return
        }
        let clients = SimulatorAudioClients.current(launchdPid: launchdPid)
        guard clients != (active?.clients ?? [:]) else {
            return
        }
        do {
            try rebuild(clients: clients)
        } catch let error as LoopbackError {
            LoopbackMain.fail(error)
        } catch {
            LoopbackMain.fail(LoopbackError(.audioFailed, "\(error)"))
        }
    }

    private func rebuild(clients: [AudioObjectID: Int32]) throws {
        destroyTap()
        // A plain stderr line: the daemon logs it at debug level.
        LoopbackMain.report("tapping \(clients.count) audio clients of launchd_sim \(launchdPid)")
        guard !clients.isEmpty else {
            return
        }
        let description = CATapDescription(stereoMixdownOfProcesses: Array(clients.keys))
        description.name = "AutoMobile simulator tap \(launchdPid)"
        description.isPrivate = true
        description.muteBehavior = mute ? .muted : .unmuted
        var tapID = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else {
            throw LoopbackError.status(status, "Creating a process tap")
        }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "AutoMobile simulator tap \(launchdPid)",
            kAudioAggregateDeviceUIDKey: "dev.jasonpearson.automobile.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true],
            ],
        ]
        var aggregateID = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else {
            AudioHardwareDestroyProcessTap(tapID)
            throw LoopbackError.status(status, "Creating the tap's aggregate device")
        }
        do {
            let procID = try startIO(tapID: tapID, aggregateID: aggregateID)
            active = ActiveTap(tapID: tapID, aggregateID: aggregateID, procID: procID, clients: clients)
            markTapDelivered()
        } catch {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            AudioHardwareDestroyProcessTap(tapID)
            throw error
        }
    }

    private func startIO(tapID: AudioObjectID, aggregateID: AudioObjectID) throws -> AudioDeviceIOProcID {
        var format = AudioStreamBasicDescription()
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var status = AudioObjectGetPropertyData(tapID, &property, 0, nil, &size, &format)
        guard status == noErr else {
            throw LoopbackError.status(status, "Reading the tap's format")
        }
        guard format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32 else {
            throw LoopbackError(
                .audioFailed,
                "The tap delivers an unexpected format (flags \(format.mFormatFlags), "
                    + "\(format.mBitsPerChannel) bits)."
            )
        }
        let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        let channels = Int(format.mChannelsPerFrame)
        resampler = MonoResampler(inputRate: format.mSampleRate, outputRate: Double(sampleRate))
        generation += 1
        let current = generation
        var procID: AudioDeviceIOProcID?
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { [weak self] _, input, _, _, _ in
            // The buffers are only valid during the call, so mix them to mono here and hand off a copy.
            let mono = Self.mono(input, interleaved: interleaved, channels: channels)
            self?.markTapDelivered()
            self?.queue.async { [weak self] in
                self?.receive(mono, generation: current)
            }
        }
        guard status == noErr, let procID else {
            throw LoopbackError.status(status, "Creating the tap's IOProc")
        }
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else {
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            throw LoopbackError.status(status, "Starting the tap's aggregate device")
        }
        return procID
    }

    private func markTapDelivered() {
        let now = DispatchTime.now().uptimeNanoseconds
        lastTapNanos.withLock { $0 = now }
    }

    private func receive(_ mono: [Float], generation current: Int) {
        guard current == generation, !done, var resampler else {
            return
        }
        let samples = resampler.resample(mono)
        self.resampler = resampler
        write(samples)
    }

    /// One mono sample per frame: averages an interleaved buffer's channels, or one-channel buffers
    /// (a non-interleaved tap).
    private static func mono(_ input: UnsafePointer<AudioBufferList>, interleaved: Bool, channels: Int) -> [Float] {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        let planes = buffers.compactMap { buffer -> UnsafeBufferPointer<Float>? in
            guard let data = buffer.mData else {
                return nil
            }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            return UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: count)
        }
        if interleaved, let plane = planes.first {
            return MonoMix.interleaved(plane, channels: channels)
        }
        guard let frames = planes.map(\.count).min(), frames > 0 else {
            return []
        }
        return (0 ..< frames).map { frame in
            planes.reduce(Float(0)) { $0 + $1[frame] } / Float(planes.count)
        }
    }

    private func write(_ samples: [Float]) {
        guard !done, !samples.isEmpty else {
            return
        }
        let usable = Array(samples.prefix(remainingFrames))
        do {
            try output.write(contentsOf: Pcm16Mono.encode(usable))
        } catch {
            // The reader went away; nobody is left to receive the rest.
            finish(code: 1)
            return
        }
        framesWritten += usable.count
        if remainingFrames != Int.max {
            remainingFrames -= usable.count
            if remainingFrames <= 0 {
                finish(code: 0)
            }
        }
    }

    private func destroyTap() {
        guard let tap = active else {
            return
        }
        active = nil
        generation += 1
        AudioDeviceStop(tap.aggregateID, tap.procID)
        AudioDeviceDestroyIOProcID(tap.aggregateID, tap.procID)
        AudioHardwareDestroyAggregateDevice(tap.aggregateID)
        AudioHardwareDestroyProcessTap(tap.tapID)
    }

    private func finish(code: Int32) {
        guard !done else {
            return
        }
        done = true
        ticker?.cancel()
        if let listener {
            var property = Self.processListAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &property, queue, listener)
        }
        destroyTap()
        finished(code)
    }

    private static var processListAddress: AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
    }
}
