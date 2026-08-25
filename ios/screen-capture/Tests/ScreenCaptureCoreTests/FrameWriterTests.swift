// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

import XCTest
@testable import ScreenCaptureCore

final class BufferSink: FrameSink {
    var data = Data()
    func write(_ chunk: Data) { data.append(chunk) }
}

final class BlockingPayloadSink: FrameSink {
    private let lock = NSLock()
    private var writeCount = 0
    private let firstPayloadStarted = DispatchSemaphore(value: 0)
    private let allowFirstPayload = DispatchSemaphore(value: 0)
    private(set) var writes: [Data] = []
    private var writtenPayloads: [Data] = []

    func write(_ chunk: Data) {
        lock.lock()
        writes.append(chunk)
        writeCount += 1
        if writeCount.isMultiple(of: 2) {
            writtenPayloads.append(chunk)
        }
        let shouldBlock = writeCount == 2
        lock.unlock()

        if shouldBlock {
            firstPayloadStarted.signal()
            _ = allowFirstPayload.wait(timeout: .now() + 1)
        }
    }

    func waitForFirstPayload() -> Bool {
        firstPayloadStarted.wait(timeout: .now() + 1) == .success
    }

    func allowOutput() {
        allowFirstPayload.signal()
    }

    func payloads() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return writtenPayloads
    }
}

final class FrameWriterTests: XCTestCase {
    func testRecordsEncoderDroppedFrameInMetrics() {
        let writer = FrameWriter(sink: BufferSink())

        writer.recordEncoderDroppedFrame()

        XCTAssertEqual(writer.metrics().droppedFrames, 1)
    }

    func testWritesHeaderFollowedByPayload() {
        let sink = BufferSink()
        let start = Date(timeIntervalSince1970: 0)
        let writer = FrameWriter(sink: sink, startTime: start)

        let width = 2
        let height = 3
        let bytesPerRow = 8
        // 24 bytes of BGRA: 2px × 3 rows × 4 bytes
        let payload = Array(0..<UInt8(bytesPerRow * height))

        _ = payload.withUnsafeBufferPointer { ptr in
            writer.write(
                width: width,
                height: height,
                bytesPerRow: bytesPerRow,
                baseAddress: UnsafeRawPointer(ptr.baseAddress!),
                timestamp: Date(timeIntervalSince1970: 0.5)
            )
        }
        writer.flush()

        XCTAssertEqual(sink.data.count, FrameProtocol.headerSize + bytesPerRow * height)
        let header = FrameProtocol.decodeHeader(sink.data.prefix(FrameProtocol.headerSize))
        XCTAssertEqual(header?.width, UInt32(width))
        XCTAssertEqual(header?.height, UInt32(height))
        XCTAssertEqual(header?.bytesPerRow, UInt32(bytesPerRow))
        XCTAssertEqual(header?.timestampMs, 500)
        XCTAssertEqual(Array(sink.data.dropFirst(FrameProtocol.headerSize)), payload)
    }

    func testTimestampClampedToZeroForPriorStartTime() {
        let sink = BufferSink()
        let writer = FrameWriter(
            sink: sink,
            startTime: Date(timeIntervalSince1970: 100)
        )
        let payload: [UInt8] = [0, 1, 2, 3]
        _ = payload.withUnsafeBufferPointer { ptr in
            writer.write(
                width: 1,
                height: 1,
                bytesPerRow: 4,
                baseAddress: UnsafeRawPointer(ptr.baseAddress!),
                timestamp: Date(timeIntervalSince1970: 0)
            )
        }
        writer.flush()
        let header = FrameProtocol.decodeHeader(sink.data.prefix(FrameProtocol.headerSize))
        XCTAssertEqual(header?.timestampMs, 0)
    }

    func testSlowSinkKeepsOnlyTheNewestPendingFrame() {
        let sink = BlockingPayloadSink()
        let writer = FrameWriter(
            sink: sink,
            configuration: .init(maximumPendingFrameBytes: 4)
        )
        let first: [UInt8] = [0x11, 0x11, 0x11, 0x11]
        let stale: [UInt8] = [0x22, 0x22, 0x22, 0x22]
        let newest: [UInt8] = [0x33, 0x33, 0x33, 0x33]

        first.withUnsafeBufferPointer { ptr in
            XCTAssertTrue(writer.write(width: 1, height: 1, bytesPerRow: 4, baseAddress: ptr.baseAddress!))
        }
        XCTAssertTrue(sink.waitForFirstPayload())
        stale.withUnsafeBufferPointer { ptr in
            XCTAssertTrue(writer.write(width: 1, height: 1, bytesPerRow: 4, baseAddress: ptr.baseAddress!))
        }
        newest.withUnsafeBufferPointer { ptr in
            XCTAssertTrue(writer.write(width: 1, height: 1, bytesPerRow: 4, baseAddress: ptr.baseAddress!))
        }

        let metrics = writer.metrics()
        XCTAssertEqual(metrics.frameQueueDepth, 1)
        XCTAssertEqual(metrics.droppedFrames, 1)
        XCTAssertEqual(metrics.bytesQueued, 4)
        XCTAssertEqual(metrics.highWaterMarkBytes, 4)

        sink.allowOutput()
        writer.flush()

        XCTAssertEqual(sink.payloads(), [Data(first), Data(newest)])
        XCTAssertEqual(writer.metrics().frameQueueDepth, 0)
    }

    func testSlowSinkDrainsOrderedAudioBeforeAnotherPendingFrame() {
        let sink = BlockingPayloadSink()
        let writer = FrameWriter(
            sink: sink,
            configuration: .init(maximumPendingFrameBytes: 4, maximumPendingAudioBytes: 8)
        )
        let first: [UInt8] = [0x11, 0x11, 0x11, 0x11]
        let newest: [UInt8] = [0x33, 0x33, 0x33, 0x33]
        let firstAudio = Data([0xaa, 0xaa, 0xaa, 0xaa])
        let secondAudio = Data([0xbb, 0xbb, 0xbb, 0xbb])

        first.withUnsafeBufferPointer { ptr in
            XCTAssertTrue(writer.write(width: 1, height: 1, bytesPerRow: 4, baseAddress: ptr.baseAddress!))
        }
        XCTAssertTrue(sink.waitForFirstPayload())

        writer.writeAudio(pcm16le: firstAudio)
        writer.writeAudio(pcm16le: secondAudio)
        newest.withUnsafeBufferPointer { ptr in
            XCTAssertTrue(writer.write(width: 1, height: 1, bytesPerRow: 4, baseAddress: ptr.baseAddress!))
        }

        XCTAssertEqual(writer.metrics().bytesQueued, 12)
        sink.allowOutput()
        writer.flush()

        XCTAssertEqual(
            sink.payloads(),
            [Data(first), firstAudio, Data(newest), secondAudio]
        )
        XCTAssertEqual(writer.metrics().bytesQueued, 0)
    }

    func testDropsFrameWhenPayloadLengthOverflows() {
        let sink = BufferSink()
        let writer = FrameWriter(sink: sink, startTime: Date(timeIntervalSince1970: 0))
        let scratch: [UInt8] = [0]

        let accepted = scratch.withUnsafeBufferPointer { ptr in
            // bytesPerRow * height overflows Int; the frame must drop, not trap.
            writer.write(
                width: 1,
                height: 2,
                bytesPerRow: Int.max,
                baseAddress: UnsafeRawPointer(ptr.baseAddress!),
                timestamp: Date(timeIntervalSince1970: 0.1)
            )
        }
        writer.flush()

        XCTAssertFalse(accepted)
        XCTAssertEqual(sink.data.count, 0)
        XCTAssertEqual(writer.metrics().droppedFrames, 1)
    }

    func testDropsFrameWhenDimensionExceedsUInt32() {
        let sink = BufferSink()
        let writer = FrameWriter(sink: sink, startTime: Date(timeIntervalSince1970: 0))
        let scratch: [UInt8] = [0, 0, 0, 0]

        let accepted = scratch.withUnsafeBufferPointer { ptr in
            // Small payload passes the cap, but width does not fit UInt32.
            writer.write(
                width: Int(UInt32.max) + 1,
                height: 1,
                bytesPerRow: 4,
                baseAddress: UnsafeRawPointer(ptr.baseAddress!),
                timestamp: Date(timeIntervalSince1970: 0.1)
            )
        }
        writer.flush()

        XCTAssertFalse(accepted)
        XCTAssertEqual(sink.data.count, 0)
        XCTAssertEqual(writer.metrics().droppedFrames, 1)
    }

    func testSlowSinkDiscardsEmptyAudioRecords() {
        let sink = BlockingPayloadSink()
        let writer = FrameWriter(
            sink: sink,
            configuration: .init(maximumPendingFrameBytes: 4)
        )
        let first: [UInt8] = [0x11, 0x11, 0x11, 0x11]

        first.withUnsafeBufferPointer { ptr in
            XCTAssertTrue(writer.write(width: 1, height: 1, bytesPerRow: 4, baseAddress: ptr.baseAddress!))
        }
        XCTAssertTrue(sink.waitForFirstPayload())

        for _ in 0..<10 {
            writer.writeAudio(pcm16le: Data())
        }

        sink.allowOutput()
        writer.flush()

        XCTAssertEqual(sink.payloads(), [Data(first)])
        XCTAssertEqual(writer.metrics().bytesQueued, 0)
    }
}
