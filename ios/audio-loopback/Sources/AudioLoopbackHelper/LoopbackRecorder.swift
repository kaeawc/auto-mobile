import AudioLoopbackCore
import AudioToolbox
import Foundation

/// Records a fixed duration from a device to stdout, then ends the process. All mutable state is
/// touched only on `callbackQueue`.
final class LoopbackRecorder: @unchecked Sendable {
    private let callbackQueue = DispatchQueue(label: "dev.jasonpearson.automobile.audio-loopback.capture")
    private let output = FileHandle.standardOutput
    private let sampleRate: Int
    private let finished: @Sendable (Int32) -> Void
    private var audioQueue: AudioQueueRef?
    private var remainingBytes: Int
    private var done = false

    init(sampleRate: Int, durationMs: Int, finished: @escaping @Sendable (Int32) -> Void) {
        self.sampleRate = sampleRate
        remainingBytes = Pcm16Mono.bytes(durationMs: durationMs, sampleRate: sampleRate)
        self.finished = finished
    }

    func start(on device: LoopbackDevice) throws {
        var format = AudioQueueSupport.pcm16Mono(sampleRate: sampleRate)
        var created: AudioQueueRef?
        let status = AudioQueueNewInputWithDispatchQueue(
            &created,
            &format,
            0,
            callbackQueue
        ) { [self] _, buffer, _, _, _ in
            drain(buffer)
        }
        guard status == noErr, let created else {
            throw LoopbackError.status(status, "Opening an input queue")
        }
        audioQueue = created
        try AudioQueueSupport.use(device, on: created)
        let buffers = try AudioQueueSupport.allocateBuffers(
            created,
            bytes: AudioQueueSupport.bufferBytes(sampleRate: sampleRate)
        )
        for buffer in buffers {
            let enqueued = AudioQueueEnqueueBuffer(created, buffer, 0, nil)
            guard enqueued == noErr else {
                throw LoopbackError.status(enqueued, "Queueing a capture buffer")
            }
        }
        // Reading an input device needs the host's Microphone permission for this process.
        let started = AudioQueueStart(created, nil)
        guard started == noErr else {
            throw LoopbackError.status(started, "Starting capture from '\(device.name)' (check the host's "
                + "Microphone permission for this process)")
        }
        LoopbackMain.report(LoopbackMarker.ready(deviceName: device.name))
    }

    /// Writes a filled buffer to stdout and re-queues it until the duration is reached.
    private func drain(_ buffer: AudioQueueBufferRef) {
        guard let queue = audioQueue, !done else {
            return
        }
        let usable = min(Int(buffer.pointee.mAudioDataByteSize), remainingBytes)
        if usable > 0 {
            do {
                try output.write(contentsOf: Data(bytes: buffer.pointee.mAudioData, count: usable))
            } catch {
                // The reader went away; nobody is left to receive the rest.
                finish(queue, code: 1)
                return
            }
            remainingBytes -= usable
        }
        if remainingBytes <= 0 {
            finish(queue, code: 0)
            return
        }
        let status = AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
        if status != noErr {
            LoopbackMain.fail(LoopbackError.status(status, "Re-queueing a capture buffer"))
        }
    }

    private func finish(_ queue: AudioQueueRef, code: Int32) {
        done = true
        AudioQueueStop(queue, true)
        AudioQueueDispose(queue, true)
        finished(code)
    }
}
