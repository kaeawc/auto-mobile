import Foundation

/// Sink that receives encoded frames. Implementations write to stdout, a file,
/// a Unix socket, or an in-memory buffer for tests.
public protocol FrameSink: AnyObject {
    func write(_ data: Data)
}

/// Snapshot of the raw-frame handoff. The video queue is structurally one slot:
/// at most one newest frame can wait while stdout is blocked.
public struct FrameWriterMetrics: Codable, Equatable {
    public let captureTimestampMs: UInt32?
    public let frameQueueAgeMs: Double?
    public let frameQueueDepth: Int
    public let droppedFrames: UInt64
    public let bytesQueued: Int
    public let highWaterMarkBytes: Int
    public let lastOutputWriteDurationMs: Double?

    public init(
        captureTimestampMs: UInt32?,
        frameQueueAgeMs: Double?,
        frameQueueDepth: Int,
        droppedFrames: UInt64,
        bytesQueued: Int,
        highWaterMarkBytes: Int,
        lastOutputWriteDurationMs: Double?
    ) {
        self.captureTimestampMs = captureTimestampMs
        self.frameQueueAgeMs = frameQueueAgeMs
        self.frameQueueDepth = frameQueueDepth
        self.droppedFrames = droppedFrames
        self.bytesQueued = bytesQueued
        self.highWaterMarkBytes = highWaterMarkBytes
        self.lastOutputWriteDurationMs = lastOutputWriteDurationMs
    }
}

/// Writes framed BGRA records to a `FrameSink` without blocking the capture
/// callback. Pixel data is copied while the caller holds its CVPixelBuffer lock,
/// then a serial output worker writes only the newest pending frame.
public final class FrameWriter {
    public struct Configuration {
        /// Enough for current iPhone and iPad BGRA captures, while bounding raw
        /// buffering to one frame when stdout's consumer is slow.
        public static let defaultMaximumPendingFrameBytes = 32 * 1024 * 1024
        public static let defaultMaximumPendingAudioBytes = 64 * 1024

        public let maximumPendingFrameBytes: Int
        public let maximumPendingAudioBytes: Int

        public init(
            maximumPendingFrameBytes: Int = defaultMaximumPendingFrameBytes,
            maximumPendingAudioBytes: Int = defaultMaximumPendingAudioBytes
        ) {
            precondition(maximumPendingFrameBytes > 0)
            precondition(maximumPendingAudioBytes > 0)
            self.maximumPendingFrameBytes = maximumPendingFrameBytes
            self.maximumPendingAudioBytes = maximumPendingAudioBytes
        }
    }

    private struct PendingRecord {
        let header: Data
        let payload: Data
        let captureTimestampMs: UInt32?
        let enqueuedAt: Date
    }

    private enum RecordKind {
        case frame
        case audio
    }

    private let sink: FrameSink
    private let startTime: Date
    private let configuration: Configuration
    private let stateLock = NSLock()
    private let outputQueue = DispatchQueue(label: "automobile.screen-capture.stdout")
    private var pendingFrame: PendingRecord?
    private var pendingAudio: [PendingRecord] = []
    private var pendingAudioBytes = 0
    private var lastWrittenRecordKind: RecordKind?
    private var outputWorkerScheduled = false
    private var droppedFrames: UInt64 = 0
    private var latestCaptureTimestampMs: UInt32?
    private var highWaterMarkBytes = 0
    private var lastOutputWriteDurationMs: Double?

    public init(
        sink: FrameSink,
        startTime: Date = Date(),
        configuration: Configuration = Configuration()
    ) {
        self.sink = sink
        self.startTime = startTime
        self.configuration = configuration
    }

    /// Copies an unlocked-safe frame and atomically replaces any unread older
    /// frame. `false` means the raw frame exceeded the fixed memory budget.
    @discardableResult
    public func write(
        width: Int,
        height: Int,
        bytesPerRow: Int,
        baseAddress: UnsafeRawPointer,
        timestamp: Date = Date()
    ) -> Bool {
        let payloadLength = bytesPerRow * height
        let elapsedMs = max(0, timestamp.timeIntervalSince(startTime) * 1000)
        let captureTimestampMs = UInt32(truncatingIfNeeded: UInt64(elapsedMs))
        guard payloadLength <= configuration.maximumPendingFrameBytes else {
            stateLock.lock()
            latestCaptureTimestampMs = captureTimestampMs
            droppedFrames += 1
            stateLock.unlock()
            return false
        }

        let header = FrameProtocol.encodeHeader(FrameProtocol.Header(
            width: UInt32(width),
            height: UInt32(height),
            bytesPerRow: UInt32(bytesPerRow),
            timestampMs: captureTimestampMs
        ))
        // The capture callback owns the pixel-buffer lock. This one copy lets it
        // release that lock before stdout can block on a slow Node consumer.
        let payload = Data(bytes: baseAddress, count: payloadLength)
        let record = PendingRecord(
            header: header,
            payload: payload,
            captureTimestampMs: captureTimestampMs,
            enqueuedAt: Date()
        )

        enqueueFrame(record)
        return true
    }

    /// Queues bounded, ordered audio records on the same serial writer. Unlike
    /// video, PCM records cannot be replaced without creating audible gaps.
    public func writeAudio(pcm16le: Data) {
        guard !pcm16le.isEmpty,
              pcm16le.count <= configuration.maximumPendingAudioBytes else {
            return
        }
        let record = PendingRecord(
            header: FrameProtocol.encodeAudioHeader(payloadLength: pcm16le.count),
            payload: pcm16le,
            captureTimestampMs: nil,
            enqueuedAt: Date()
        )

        stateLock.lock()
        while pendingAudioBytes + record.payload.count > configuration.maximumPendingAudioBytes,
              let dropped = pendingAudio.first {
            pendingAudio.removeFirst()
            pendingAudioBytes -= dropped.payload.count
        }
        pendingAudio.append(record)
        pendingAudioBytes += record.payload.count
        highWaterMarkBytes = max(highWaterMarkBytes, queuedBytesLocked())
        let shouldSchedule = !outputWorkerScheduled
        outputWorkerScheduled = true
        stateLock.unlock()
        if shouldSchedule {
            outputQueue.async { self.drain() }
        }
    }

    public func metrics(now: Date = Date()) -> FrameWriterMetrics {
        stateLock.lock()
        defer { stateLock.unlock() }
        let pending = pendingFrame
        return FrameWriterMetrics(
            captureTimestampMs: pending?.captureTimestampMs ?? latestCaptureTimestampMs,
            frameQueueAgeMs: pending.map { max(0, now.timeIntervalSince($0.enqueuedAt) * 1000) },
            frameQueueDepth: pending == nil ? 0 : 1,
            droppedFrames: droppedFrames,
            bytesQueued: queuedBytesLocked(),
            highWaterMarkBytes: highWaterMarkBytes,
            lastOutputWriteDurationMs: lastOutputWriteDurationMs
        )
    }

    /// Waits for all records scheduled before this call. Intended for tests and
    /// orderly shutdown; production capture never blocks its callback on this.
    public func flush() {
        outputQueue.sync {}
    }

    private func enqueueFrame(_ record: PendingRecord) {
        stateLock.lock()
        latestCaptureTimestampMs = record.captureTimestampMs
        if pendingFrame != nil {
            droppedFrames += 1
        }
        pendingFrame = record
        highWaterMarkBytes = max(highWaterMarkBytes, queuedBytesLocked())
        let shouldSchedule = !outputWorkerScheduled
        outputWorkerScheduled = true
        stateLock.unlock()
        if shouldSchedule {
            outputQueue.async { self.drain() }
        }
    }

    private func drain() {
        while let record = takeNextRecord() {
            let startedAt = Date()
            sink.write(record.header)
            sink.write(record.payload)
            let durationMs = max(0, Date().timeIntervalSince(startedAt) * 1000)
            stateLock.lock()
            lastOutputWriteDurationMs = durationMs
            stateLock.unlock()
        }
    }

    private func takeNextRecord() -> PendingRecord? {
        stateLock.lock()
        defer { stateLock.unlock() }

        if pendingFrame != nil, !pendingAudio.isEmpty {
            if lastWrittenRecordKind == .frame {
                return takeAudioLocked()
            }
            return takeFrameLocked()
        }
        if pendingFrame != nil {
            return takeFrameLocked()
        }
        if !pendingAudio.isEmpty {
            return takeAudioLocked()
        }
        outputWorkerScheduled = false
        return nil
    }

    private func takeFrameLocked() -> PendingRecord? {
        guard let frame = pendingFrame else { return nil }
        pendingFrame = nil
        lastWrittenRecordKind = .frame
        return frame
    }

    private func takeAudioLocked() -> PendingRecord {
        let audio = pendingAudio.removeFirst()
        pendingAudioBytes -= audio.payload.count
        lastWrittenRecordKind = .audio
        return audio
    }

    private func queuedBytesLocked() -> Int {
        (pendingFrame?.payload.count ?? 0) + pendingAudioBytes
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
