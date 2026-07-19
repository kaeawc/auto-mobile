// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

import XCTest
@testable import ScreenCaptureCore

final class BufferSink: FrameSink {
    var data = Data()
    func write(_ chunk: Data) { data.append(chunk) }
}

final class FrameWriterTests: XCTestCase {
    func testWritesHeaderFollowedByPayload() {
        let sink = BufferSink()
        let start = Date(timeIntervalSince1970: 0)
        let writer = FrameWriter(sink: sink, startTime: start)

        let width = 2
        let height = 3
        let bytesPerRow = 8
        // 24 bytes of BGRA: 2px × 3 rows × 4 bytes
        let payload = Array(0..<UInt8(bytesPerRow * height))

        payload.withUnsafeBufferPointer { ptr in
            writer.write(
                width: width,
                height: height,
                bytesPerRow: bytesPerRow,
                baseAddress: UnsafeRawPointer(ptr.baseAddress!),
                timestamp: Date(timeIntervalSince1970: 0.5)
            )
        }

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
        payload.withUnsafeBufferPointer { ptr in
            writer.write(
                width: 1,
                height: 1,
                bytesPerRow: 4,
                baseAddress: UnsafeRawPointer(ptr.baseAddress!),
                timestamp: Date(timeIntervalSince1970: 0)
            )
        }
        let header = FrameProtocol.decodeHeader(sink.data.prefix(FrameProtocol.headerSize))
        XCTAssertEqual(header?.timestampMs, 0)
    }
}
