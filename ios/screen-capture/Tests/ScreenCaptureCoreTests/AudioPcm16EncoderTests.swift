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
}
