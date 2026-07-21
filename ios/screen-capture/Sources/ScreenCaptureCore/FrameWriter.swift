import Foundation

/// Sink that receives encoded frames. Implementations write to stdout, a file,
/// a Unix socket, or an in-memory buffer for tests.
public protocol FrameSink: AnyObject {
    func write(_ data: Data)
}

/// Writes encoded frame header + BGRA payload to a `FrameSink`.
public final class FrameWriter {
    private let sink: FrameSink
    private let startTime: Date

    public init(sink: FrameSink, startTime: Date = Date()) {
        self.sink = sink
        self.startTime = startTime
    }

    public func write(
        width: Int,
        height: Int,
        bytesPerRow: Int,
        baseAddress: UnsafeRawPointer,
        timestamp: Date = Date()
    ) {
        let elapsedMs = max(0, timestamp.timeIntervalSince(startTime) * 1000)
        let header = FrameProtocol.Header(
            width: UInt32(width),
            height: UInt32(height),
            bytesPerRow: UInt32(bytesPerRow),
            timestampMs: UInt32(truncatingIfNeeded: UInt64(elapsedMs))
        )
        sink.write(FrameProtocol.encodeHeader(header))
        // bytesNoCopy avoids copying the pixel buffer into a transient Data.
        // The caller (DeviceCaptureSession.captureOutput) holds the underlying
        // CVPixelBuffer locked for the duration of this synchronous write.
        let payload = Data(
            bytesNoCopy: UnsafeMutableRawPointer(mutating: baseAddress),
            count: bytesPerRow * height,
            deallocator: .none
        )
        sink.write(payload)
    }

    public func writeAudio(pcm16le: Data) {
        sink.write(FrameProtocol.encodeAudioHeader(payloadLength: pcm16le.count))
        sink.write(pcm16le)
    }
}

/// Sink that writes to a `FileHandle` (e.g. `FileHandle.standardOutput`).
public final class FileHandleFrameSink: FrameSink {
    private let handle: FileHandle

    public init(handle: FileHandle) {
        self.handle = handle
    }

    public func write(_ data: Data) {
        handle.write(data)
    }
}
