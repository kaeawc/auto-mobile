// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

import XCTest
@testable import ScreenCaptureCore

final class FrameProtocolTests: XCTestCase {
    func testEncodeAudioHeaderUsesReservedZeroWidthMarker() {
        let data = FrameProtocol.encodeAudioHeader(payloadLength: 320)

        XCTAssertEqual(data.count, FrameProtocol.headerSize)
        // Marker "AMF1" on the wire.
        XCTAssertEqual(Array(data.prefix(4)), [0x41, 0x4D, 0x46, 0x31])
        // Field bytes (offset 8): width=0, height=8000 (0x1F40), bytesPerRow=1, timestampMs=320 (0x140).
        XCTAssertEqual(Array(data[8..<24]), [
            0, 0, 0, 0,
            0x40, 0x1F, 0, 0,
            1, 0, 0, 0,
            0x40, 1, 0, 0,
        ])
        XCTAssertEqual(
            FrameProtocol.decodeHeader(data),
            FrameProtocol.Header(width: 0, height: 8_000, bytesPerRow: 1, timestampMs: 320)
        )
    }

    func testEncodeHeaderPlacesMarkerChecksumAndLittleEndianFields() {
        let header = FrameProtocol.Header(
            width: 0x01020304,
            height: 0x05060708,
            bytesPerRow: 0x090A0B0C,
            timestampMs: 0x0D0E0F10
        )
        let data = FrameProtocol.encodeHeader(header)
        XCTAssertEqual(data.count, FrameProtocol.headerSize)
        XCTAssertEqual(data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }, FrameProtocol.magic)
        XCTAssertEqual(Array(data[8..<24]), [
            0x04, 0x03, 0x02, 0x01,
            0x08, 0x07, 0x06, 0x05,
            0x0C, 0x0B, 0x0A, 0x09,
            0x10, 0x0F, 0x0E, 0x0D,
        ])
        // The stored checksum matches the CRC-32 of the field bytes.
        let storedChecksum = data.dropFirst(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
        XCTAssertEqual(storedChecksum, FrameProtocol.crc32(data.subdata(in: 8..<24)))
        XCTAssertEqual(FrameProtocol.decodeHeader(data), header)
    }

    func testCrc32MatchesStandardCheckVector() {
        // The canonical CRC-32 check value for the ASCII string "123456789",
        // shared with the TypeScript decoder so the two agree byte for byte.
        XCTAssertEqual(FrameProtocol.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testDecodeRejectsWrongMarker() {
        var data = FrameProtocol.encodeHeader(
            FrameProtocol.Header(width: 2, height: 2, bytesPerRow: 8, timestampMs: 1)
        )
        data[0] ^= 0xFF // corrupt the marker
        XCTAssertNil(FrameProtocol.decodeHeader(data))
    }

    func testDecodeRejectsWrongChecksum() {
        var data = FrameProtocol.encodeHeader(
            FrameProtocol.Header(width: 2, height: 2, bytesPerRow: 8, timestampMs: 1)
        )
        data[8] ^= 0xFF // corrupt a field without fixing the checksum
        XCTAssertNil(FrameProtocol.decodeHeader(data))
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
