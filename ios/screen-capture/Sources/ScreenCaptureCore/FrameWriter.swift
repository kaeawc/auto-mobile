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
        /// Bound on the ordered encoded-H.264 output queue (issue #4788). Unlike
        /// raw frames, encoded records are never dropped — overflow is fatal — so
        /// this ceiling is a hard backstop against unbounded growth when stdout's
        /// consumer stalls, sized for several seconds of Baseline output.
        public static let defaultMaximumPendingEncodedBytes = 64 * 1024 * 1024

        public let maximumPendingFrameBytes: Int
        public let maximumPendingAudioBytes: Int
        public let maximumPendingEncodedBytes: Int

        public init(
            maximumPendingFrameBytes: Int = defaultMaximumPendingFrameBytes,
            maximumPendingAudioBytes: Int = defaultMaximumPendingAudioBytes,
            maximumPendingEncodedBytes: Int = defaultMaximumPendingEncodedBytes
        ) {
            precondition(maximumPendingFrameBytes > 0)
            precondition(maximumPendingAudioBytes > 0)
            precondition(maximumPendingEncodedBytes > 0)
            self.maximumPendingFrameBytes = maximumPendingFrameBytes
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
        case frame
        case audio
        case encoded
    }

    private let sink: FrameSink
    private let startTime: Date
    private let configuration: Configuration
    private let stateLock = NSLock()
    private let outputQueue = DispatchQueue(label: "automobile.screen-capture.stdout")
    private var pendingFrame: PendingRecord?
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
        let elapsedMs = max(0, timestamp.timeIntervalSince(startTime) * 1000)
        let captureTimestampMs = UInt32(truncatingIfNeeded: UInt64(elapsedMs))

        // `bytesPerRow * height` can overflow Int for pathological geometry;
        // compute it defensively and drop the frame instead of trapping, before
        // the memory-budget cap so the cap never sees a wrapped value.
        let (payloadLength, overflow) = bytesPerRow.multipliedReportingOverflow(by: height)
        guard !overflow, payloadLength <= configuration.maximumPendingFrameBytes else {
            recordDroppedFrame(captureTimestampMs: captureTimestampMs)
            return false
        }

        // The header fields are UInt32; a value that doesn't fit would trap on
        // conversion, so drop the frame instead.
        guard let headerWidth = UInt32(exactly: width),
              let headerHeight = UInt32(exactly: height),
              let headerBytesPerRow = UInt32(exactly: bytesPerRow) else {
            recordDroppedFrame(captureTimestampMs: captureTimestampMs)
            return false
        }

        let header = FrameProtocol.encodeHeader(FrameProtocol.Header(
            width: headerWidth,
            height: headerHeight,
            bytesPerRow: headerBytesPerRow,
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

    private func recordDroppedFrame(captureTimestampMs: UInt32) {
        stateLock.lock()
        latestCaptureTimestampMs = captureTimestampMs
        droppedFrames += 1
        stateLock.unlock()
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

        // "Media" is a raw frame or an encoded record; only one of the two ever
        // flows in a given run (raw path vs `--encode h264`). Alternate media
        // with audio so neither starves — preserving the raw path's exact
        // frame/audio ordering when no encoded records are present.
        let mediaPending = pendingFrame != nil || !pendingEncoded.isEmpty
        if mediaPending, !pendingAudio.isEmpty {
            let lastWasMedia = lastWrittenRecordKind == .frame || lastWrittenRecordKind == .encoded
            return lastWasMedia ? takeAudioLocked() : takeMediaLocked()
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

    /// Encoded records take priority over a raw frame (they never coexist), and
    /// are emitted strictly FIFO — they must not be reordered or dropped.
    private func takeMediaLocked() -> PendingRecord? {
        if !pendingEncoded.isEmpty {
            let encoded = pendingEncoded.removeFirst()
            pendingEncodedBytes -= encoded.payload.count
            lastWrittenRecordKind = .encoded
            return encoded
        }
        return takeFrameLocked()
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
        (pendingFrame?.payload.count ?? 0) + pendingAudioBytes + pendingEncodedBytes
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
