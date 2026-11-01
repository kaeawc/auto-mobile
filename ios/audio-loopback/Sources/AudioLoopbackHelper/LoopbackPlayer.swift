import AudioLoopbackCore
import AudioToolbox
import Foundation

/// Plays stdin into a device until stdin ends. Reads only as buffers free up, so the writer is paced by
/// the device's real-time playback. All mutable state is touched only on `callbackQueue`.
final class LoopbackPlayer: @unchecked Sendable {
    private let callbackQueue = DispatchQueue(label: "dev.jasonpearson.automobile.audio-loopback.play")
    private let input = FileHandle.standardInput
    private let sampleRate: Int
    private let bufferBytes: Int
    private let finished: @Sendable (Int32) -> Void
    private var audioQueue: AudioQueueRef?
    private var buffers: [AudioQueueBufferRef] = []
    private var inFlight = 0
    private var inputEnded = false
    private var started = false

    init(sampleRate: Int, finished: @escaping @Sendable (Int32) -> Void) {
        self.sampleRate = sampleRate
        bufferBytes = AudioQueueSupport.bufferBytes(sampleRate: sampleRate)
        self.finished = finished
    }

    /// Opens the device, then starts playing once the first audio arrives.
    func start(on device: LoopbackDevice) throws {
        var format = AudioQueueSupport.pcm16Mono(sampleRate: sampleRate)
        var created: AudioQueueRef?
        let status = AudioQueueNewOutputWithDispatchQueue(&created, &format, 0, callbackQueue) { [self] _, buffer in
            refill(buffer)
        }
        guard status == noErr, let created else {
            throw LoopbackError.status(status, "Opening an output queue")
        }
        audioQueue = created
        try AudioQueueSupport.use(device, on: created)
        buffers = try AudioQueueSupport.allocateBuffers(created, bytes: bufferBytes)
        LoopbackMain.report(LoopbackMarker.ready(deviceName: device.name))
        // The queue and buffers stay on `self`: they are not Sendable, and `self` is only touched
        // on `callbackQueue` from here on.
        callbackQueue.async { [self] in
            prime()
        }
    }

    private func prime() {
        guard let queue = audioQueue else {
            return
        }
        inFlight = buffers.count
        for buffer in buffers {
            refill(buffer)
        }
        guard !inputEnded || inFlight > 0 else {
            return
        }
        let status = AudioQueueStart(queue, nil)
        if status != noErr {
            LoopbackMain.fail(LoopbackError.status(status, "Starting playback"))
        }
        started = true
    }

    /// Fills a free buffer from stdin and enqueues it; once stdin has ended and every buffer has
    /// played, ends the process.
    private func refill(_ buffer: AudioQueueBufferRef) {
        guard let queue = audioQueue else {
            return
        }
        let data = inputEnded ? Data() : readChunk()
        let usable = data.count - data.count % Pcm16Mono.bytesPerFrame
        guard usable > 0 else {
            inputEnded = true
            inFlight -= 1
            if inFlight == 0 {
                drainThenFinish(queue)
            }
            return
        }
        data.withUnsafeBytes { raw in
            if let base = raw.baseAddress {
                buffer.pointee.mAudioData.copyMemory(from: base, byteCount: usable)
            }
        }
        buffer.pointee.mAudioDataByteSize = UInt32(usable)
        let status = AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
        if status != noErr {
            LoopbackMain.fail(LoopbackError.status(status, "Queueing audio"))
        }
    }

    /// A returned buffer may not have played yet, so the last one is let out with a draining stop:
    /// the process ends only once the queue reports it is no longer running.
    private func drainThenFinish(_ queue: AudioQueueRef) {
        guard started else {
            AudioQueueDispose(queue, true)
            finished(0)
            return
        }
        let context = Unmanaged.passUnretained(self).toOpaque()
        let listening = AudioQueueAddPropertyListener(
            queue,
            kAudioQueueProperty_IsRunning,
            { userData, queue, _ in
                guard let userData else {
                    return
                }
                Unmanaged<LoopbackPlayer>.fromOpaque(userData).takeUnretainedValue().runningChanged(queue)
            },
            context
        )
        let stopping = AudioQueueStop(queue, false)
        if listening != noErr || stopping != noErr {
            // Without the listener there is no end signal; stop at once rather than hang.
            AudioQueueDispose(queue, true)
            finished(0)
        }
    }

    /// Called on an AudioQueue thread whenever the running state changes.
    private func runningChanged(_ queue: AudioQueueRef) {
        var running: UInt32 = 1
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioQueueGetProperty(queue, kAudioQueueProperty_IsRunning, &running, &size) == noErr,
              running == 0
        else {
            return
        }
        callbackQueue.async { [self] in
            if let audioQueue {
                AudioQueueDispose(audioQueue, true)
            }
            finished(0)
        }
    }

    /// Blocks until a full buffer or the end of stdin; a closed pipe reads as the end.
    private func readChunk() -> Data {
        do {
            return try input.read(upToCount: bufferBytes) ?? Data()
        } catch {
            LoopbackMain.report("audio-loopback: stdin read failed: \(error)")
            return Data()
        }
    }
}
