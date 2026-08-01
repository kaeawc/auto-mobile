import XCTest
@testable import ScreenCaptureCore

final class AudioPcm16EncoderTests: XCTestCase {
    func testEncodesFloat32LittleEndianAsPCM16LE() {
        let values: [Float] = [-1, 0, 1]
        let input = values.withUnsafeBytes { Data($0) }

        let output = AudioPcm16Encoder.encodeFloat32LE(input)

        XCTAssertEqual(output, Data([0x01, 0x80, 0x00, 0x00, 0xFF, 0x7F]))
    }

    func testRejectsTruncatedFloat32Input() {
        XCTAssertNil(AudioPcm16Encoder.encodeFloat32LE(Data([0, 0, 0])))
    }

    func testSafeCopyByteCountReturnsRequestedWhenBufferIsLargeEnough() {
        // 4 Int16 samples need 8 bytes and the buffer reports exactly 8.
        XCTAssertEqual(
            AudioPcm16Encoder.safeCopyByteCount(sampleCount: 4, bytesPerSample: 2, availableBytes: 8),
            8
        )
        // A buffer that reports more bytes than needed still copies only what
        // the sample count requires (the extra is padding).
        XCTAssertEqual(
            AudioPcm16Encoder.safeCopyByteCount(sampleCount: 4, bytesPerSample: 2, availableBytes: 16),
            8
        )
    }

    func testSafeCopyByteCountDropsShortBuffer() {
        // 4 Int16 samples need 8 bytes but the buffer only holds 6: copying 8
        // would over-read adjacent heap memory, so drop the buffer.
        XCTAssertNil(
            AudioPcm16Encoder.safeCopyByteCount(sampleCount: 4, bytesPerSample: 2, availableBytes: 6)
        )
    }

    func testSafeCopyByteCountRejectsMalformedArguments() {
        XCTAssertNil(
            AudioPcm16Encoder.safeCopyByteCount(sampleCount: -1, bytesPerSample: 2, availableBytes: 8)
        )
        XCTAssertNil(
            AudioPcm16Encoder.safeCopyByteCount(sampleCount: 4, bytesPerSample: 0, availableBytes: 8)
        )
        XCTAssertNil(
            AudioPcm16Encoder.safeCopyByteCount(
                sampleCount: Int.max, bytesPerSample: 2, availableBytes: Int.max
            )
        )
    }
}
