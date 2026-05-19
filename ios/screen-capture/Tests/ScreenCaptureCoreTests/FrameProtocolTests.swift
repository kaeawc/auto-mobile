import XCTest
@testable import ScreenCaptureCore

final class FrameProtocolTests: XCTestCase {
    func testEncodeHeaderProducesLittleEndianBytes() {
        let header = FrameProtocol.Header(
            width: 0x01020304,
            height: 0x05060708,
            bytesPerRow: 0x090A0B0C,
            timestampMs: 0x0D0E0F10
        )
        let data = FrameProtocol.encodeHeader(header)
        XCTAssertEqual(data.count, FrameProtocol.headerSize)
        let expected: [UInt8] = [
            0x04, 0x03, 0x02, 0x01,
            0x08, 0x07, 0x06, 0x05,
            0x0C, 0x0B, 0x0A, 0x09,
            0x10, 0x0F, 0x0E, 0x0D,
        ]
        XCTAssertEqual(Array(data), expected)
    }

    func testDecodeHeaderRoundTrip() {
        let header = FrameProtocol.Header(
            width: 1170,
            height: 2532,
            bytesPerRow: 4680,
            timestampMs: 1_234_567
        )
        let data = FrameProtocol.encodeHeader(header)
        XCTAssertEqual(FrameProtocol.decodeHeader(data), header)
    }

    func testDecodeRejectsShortBuffer() {
        let truncated = Data(repeating: 0, count: FrameProtocol.headerSize - 1)
        XCTAssertNil(FrameProtocol.decodeHeader(truncated))
    }
}
