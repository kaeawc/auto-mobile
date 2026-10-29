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
    private var inFlight = 0
    private var inputEnded = false

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
        let buffers = try AudioQueueSupport.allocateBuffers(created, bytes: bufferBytes)
        LoopbackMain.report(LoopbackMarker.ready(deviceName: device.name))
        callbackQueue.async { [self] in
            prime(created, buffers)
        }
    }

    private func prime(_ queue: AudioQueueRef, _ buffers: [AudioQueueBufferRef]) {
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
                AudioQueueStop(queue, true)
                AudioQueueDispose(queue, true)
                finished(0)
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
