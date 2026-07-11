// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

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

    /// Decoding a header from an unaligned buffer must not trap. The pre-fix
    /// `load(as:)` requires 4-byte alignment; feeding it a header at an odd
    /// address traps in debug (issue #3627). `loadUnaligned` decodes correctly.
    func testDecodeHeaderHandlesUnalignedBuffer() {
        let header = FrameProtocol.Header(
            width: 0x1122_3344,
            height: 0x5566_7788,
            bytesPerRow: 0x99AA_BBCC,
            timestampMs: 0xDDEE_FF00
        )
        let encoded = FrameProtocol.encodeHeader(header)

        // Place the 16 header bytes at an odd (unaligned) offset in a raw buffer.
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: FrameProtocol.headerSize + 1,
            alignment: 1
        )
        defer { raw.deallocate() }
        encoded.withUnsafeBytes { src in
            raw.advanced(by: 1).copyMemory(from: src.baseAddress!, byteCount: FrameProtocol.headerSize)
        }
        let unaligned = Data(
            bytesNoCopy: raw.advanced(by: 1),
            count: FrameProtocol.headerSize,
            deallocator: .none
        )

        XCTAssertEqual(FrameProtocol.decodeHeader(unaligned), header)
    }

    func testEncodeDecodeRoundTrip() {
        let header = FrameProtocol.Header(
            width: 1290, height: 2796, bytesPerRow: 5160, timestampMs: 123_456
        )
        XCTAssertEqual(FrameProtocol.decodeHeader(FrameProtocol.encodeHeader(header)), header)
    }
}
