import AudioLoopbackCore
import AudioToolbox
import Foundation

enum AudioQueueSupport {
    /// Buffers kept in flight; three is the usual minimum for gap-free AudioQueue playback.
    static let bufferCount = 3
    static let bufferMs = 50

    /// 16-bit signed little-endian mono; AudioQueue converts to and from the device's own format.
    static func pcm16Mono(sampleRate: Int) -> AudioStreamBasicDescription {
        AudioStreamBasicDescription(
            mSampleRate: Float64(sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: UInt32(Pcm16Mono.bytesPerFrame),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(Pcm16Mono.bytesPerFrame),
            mChannelsPerFrame: 1,
            mBitsPerChannel: 16,
            mReserved: 0
        )
    }

    static func bufferBytes(sampleRate: Int) -> Int {
        Pcm16Mono.bytes(durationMs: bufferMs, sampleRate: sampleRate)
    }

    /// Points the queue at `device` instead of the system default.
    static func use(_ device: LoopbackDevice, on queue: AudioQueueRef) throws {
        let uid = device.uid as CFString
        let status = withUnsafePointer(to: uid) { pointer in
            AudioQueueSetProperty(
                queue,
                kAudioQueueProperty_CurrentDevice,
                pointer,
                UInt32(MemoryLayout<CFString>.size)
            )
        }
        guard status == noErr else {
            throw LoopbackError.status(status, "Selecting '\(device.name)'")
        }
    }

    static func allocateBuffers(_ queue: AudioQueueRef, bytes: Int) throws -> [AudioQueueBufferRef] {
        try (0 ..< bufferCount).map { _ in
            var buffer: AudioQueueBufferRef?
            let status = AudioQueueAllocateBuffer(queue, UInt32(bytes), &buffer)
            guard status == noErr, let buffer else {
                throw LoopbackError.status(status, "Allocating an audio buffer")
            }
            return buffer
        }
    }
}
