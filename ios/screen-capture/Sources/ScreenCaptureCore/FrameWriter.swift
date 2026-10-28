import Darwin
import Foundation

/// Sink that receives encoded frames. Implementations write to stdout, a file,
/// a Unix socket, or an in-memory buffer for tests.
public protocol FrameSink: AnyObject {
    func write(_ data: Data)
}

/// Snapshot of the stdout handoff. Encoded records are never dropped, so the
/// video frame queue depth is always 0; `droppedFrames` counts frames the encoder
/// rejected before encoding.
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

/// Writes framed encoded-H.264 and audio records to a `FrameSink` through a serial
/// output worker, so a slow stdout consumer never blocks the capture callback.
///
/// `@unchecked Sendable`: every mutable field is confined to `stateLock`, and the
/// serial `outputQueue` is the only writer thread (it takes records under the lock
/// and calls `sink.write` off the lock so a slow consumer never blocks producers).
/// This matches the package's lock-confined-`Sendable` idiom (see `ForceKeyFrameLatch`).
public final class FrameWriter: @unchecked Sendable {
    public struct Configuration {
        public static let defaultMaximumPendingAudioBytes = 64 * 1024
        /// Bound on the ordered encoded-H.264 output queue (issue #4788). Encoded
        /// records are never dropped — overflow is fatal — so
        /// this ceiling is a hard backstop against unbounded growth when stdout's
        /// consumer stalls, sized for several seconds of Baseline output.
        public static let defaultMaximumPendingEncodedBytes = 64 * 1024 * 1024

        public let maximumPendingAudioBytes: Int
        public let maximumPendingEncodedBytes: Int

        public init(
            maximumPendingAudioBytes: Int = defaultMaximumPendingAudioBytes,
            maximumPendingEncodedBytes: Int = defaultMaximumPendingEncodedBytes
        ) {
            precondition(maximumPendingAudioBytes > 0)
            precondition(maximumPendingEncodedBytes > 0)
            self.maximumPendingAudioBytes = maximumPendingAudioBytes
            self.maximumPendingEncodedBytes = maximumPendingEncodedBytes
        }
    }

    private struct PendingRecord {
        let header: Data
        let payload: Data
        let captureTimestampMs: UInt32?
        let enqueuedAt: Date
    }

    private enum RecordKind {
        case audio
        case encoded
    }

    private let sink: FrameSink
    private let startTime: Date
    private let configuration: Configuration
    private let stateLock = NSLock()
    private let outputQueue = DispatchQueue(label: "automobile.screen-capture.stdout")
    private var pendingAudio: [PendingRecord] = []
    private var pendingAudioBytes = 0
    private var pendingEncoded: [PendingRecord] = []
    private var pendingEncodedBytes = 0
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

    /// Queues bounded, ordered audio records on the same serial writer. Unlike
    /// video, PCM records cannot be replaced without creating audible gaps.
    public func writeAudio(pcm16le: Data) {
        guard !pcm16le.isEmpty,
              pcm16le.count <= configuration.maximumPendingAudioBytes
        else {
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
              let dropped = pendingAudio.first
        {
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

    /// Queues an ordered encoded-H.264 record (header + Annex-B payload) on the
    /// same serial writer (issue #4788). Encoded records are NEVER dropped: a
    /// broken reference chain is worse than a stall, so overflow returns `false`
    /// and the caller exits (the supervisor relaunches with a fresh IDR) instead
    /// of discarding an emitted record. `header` is a `FrameProtocol`
    /// encoded-video header; `payload` is the Annex-B access unit.
    @discardableResult
    public func writeEncoded(header: Data, payload: Data) -> Bool {
        let record = PendingRecord(
            header: header,
            payload: payload,
            captureTimestampMs: nil,
            enqueuedAt: Date()
        )
        stateLock.lock()
        if EncoderDropPolicy.wouldOverflowOutputQueue(
            queuedBytes: pendingEncodedBytes,
            recordBytes: record.payload.count,
            maxQueuedBytes: configuration.maximumPendingEncodedBytes
        ) {
            stateLock.unlock()
            return false
        }
        pendingEncoded.append(record)
        pendingEncodedBytes += record.payload.count
        highWaterMarkBytes = max(highWaterMarkBytes, queuedBytesLocked())
        let shouldSchedule = !outputWorkerScheduled
        outputWorkerScheduled = true
        stateLock.unlock()
        if shouldSchedule {
            outputQueue.async { self.drain() }
        }
        return true
    }

    public func metrics(now: Date = Date()) -> FrameWriterMetrics {
        stateLock.lock()
        defer { stateLock.unlock() }
        return FrameWriterMetrics(
            captureTimestampMs: latestCaptureTimestampMs,
            frameQueueAgeMs: nil,
            frameQueueDepth: 0,
            droppedFrames: droppedFrames,
            bytesQueued: queuedBytesLocked(),
            highWaterMarkBytes: highWaterMarkBytes,
            lastOutputWriteDurationMs: lastOutputWriteDurationMs
        )
    }

    /// Records a frame rejected before VideoToolbox accepted it because the encoder was behind.
    /// This shares the source-side cumulative drop counter reported to the desktop relay.
    public func recordEncoderDroppedFrame() {
        stateLock.lock()
        droppedFrames += 1
        stateLock.unlock()
    }

    /// Waits for all records scheduled before this call. Intended for tests and
    /// orderly shutdown; production capture never blocks its callback on this.
    public func flush() {
        outputQueue.sync {}
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

        // Alternate encoded video with audio so neither starves.
        let mediaPending = !pendingEncoded.isEmpty
        if mediaPending, !pendingAudio.isEmpty {
            return lastWrittenRecordKind == .encoded ? takeAudioLocked() : takeMediaLocked()
        }
        if mediaPending {
            return takeMediaLocked()
        }
        if !pendingAudio.isEmpty {
            return takeAudioLocked()
        }
        outputWorkerScheduled = false
        return nil
    }

    /// Encoded records are emitted strictly FIFO — they must not be reordered or dropped.
    private func takeMediaLocked() -> PendingRecord? {
        guard !pendingEncoded.isEmpty else { return nil }
        let encoded = pendingEncoded.removeFirst()
        pendingEncodedBytes -= encoded.payload.count
        lastWrittenRecordKind = .encoded
        return encoded
    }

    private func takeAudioLocked() -> PendingRecord {
        let audio = pendingAudio.removeFirst()
        pendingAudioBytes -= audio.payload.count
        lastWrittenRecordKind = .audio
        return audio
    }

    private func queuedBytesLocked() -> Int {
        pendingAudioBytes + pendingEncodedBytes
    }
}

/// Sink that writes to a `FileHandle` (e.g. `FileHandle.standardOutput`).
public final class FileHandleFrameSink: FrameSink {
    private let handle: FileHandle
    private let onOutputClosed: @Sendable () -> Void
    private let stateLock = NSLock()
    private var outputClosed = false

    public init(handle: FileHandle, onOutputClosed: @escaping @Sendable () -> Void = {}) {
        self.handle = handle
        self.onOutputClosed = onOutputClosed
    }

    public func write(_ data: Data) {
        guard !stateLock.withLock({ outputClosed }) else { return }
        guard !DescriptorWrite.writeAll(data, toFileDescriptor: handle.fileDescriptor) else { return }
        let shouldNotify = stateLock.withLock { () -> Bool in
            if outputClosed { return false }
            outputClosed = true
            return true
        }
        if shouldNotify { onOutputClosed() }
    }
}
