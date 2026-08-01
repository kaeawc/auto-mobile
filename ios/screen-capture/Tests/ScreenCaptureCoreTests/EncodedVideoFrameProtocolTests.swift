import XCTest
@testable import ScreenCaptureCore

/// Pins the encoded-H.264 record kind (issue #4787) against the shared golden
/// vectors in `test/fixtures/encoded-h264-golden-vectors.json`. The TypeScript
/// `encodedVideoFrameProtocol.test.ts` decodes the SAME bytes to identical
/// fields, so the two suites pin the wire format against each other.
final class EncodedVideoFrameProtocolTests: XCTestCase {
    private struct GoldenRecord: Decodable {
        let name: String
        let keyframe: Bool
        let presentationTimestampMs: UInt32
        let payloadHex: String
        let recordHex: String
    }

    private struct Resync: Decodable {
        let corruptedRecordHex: String
        let streamHex: String
        let recoveredRecordName: String
    }

    private struct Golden: Decodable {
        let headerSize: Int
        let encodedVideoHeightBase: String
        let encodedVideoHeightMask: String
        let records: [GoldenRecord]
        let resync: Resync
    }

    private func hexToData(_ hex: String) throws -> Data {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else {
                throw XCTSkip("golden fixture has non-hex byte: \(hex[index..<next])")
            }
            data.append(byte)
            index = next
        }
        return data
    }

    private func loadGolden() throws -> Golden {
        // Walk up from this test file to the repo root, then to the shared fixture:
        // <repo>/ios/screen-capture/Tests/ScreenCaptureCoreTests/<thisFile>.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixture = root
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent("encoded-h264-golden-vectors.json")
        let data = try Data(contentsOf: fixture)
        return try JSONDecoder().decode(Golden.self, from: data)
    }

    private func record(named name: String, in golden: Golden) throws -> GoldenRecord {
        guard let found = golden.records.first(where: { $0.name == name }) else {
            throw XCTSkip("golden record \(name) missing")
        }
        return found
    }

    func testFixturePinsDiscriminatorConstants() throws {
        let golden = try loadGolden()
        XCTAssertEqual(golden.headerSize, FrameProtocol.headerSize)
        let base = UInt32(golden.encodedVideoHeightBase.dropFirst(2), radix: 16)
        let mask = UInt32(golden.encodedVideoHeightMask.dropFirst(2), radix: 16)
        XCTAssertEqual(base, FrameProtocol.encodedVideoHeightBase)
        XCTAssertEqual(mask, FrameProtocol.encodedVideoHeightMask)
    }

    func testEncoderReproducesGoldenBytesAndDecoderRoundTrips() throws {
        let golden = try loadGolden()
        for name in ["keyframe", "delta"] {
            let expected = try record(named: name, in: golden)
            let payload = try hexToData(expected.payloadHex)

            // ENCODER: re-encoding must reproduce the exact golden bytes.
            let header = FrameProtocol.encodeEncodedVideoHeader(
                payloadLength: payload.count,
                isKeyframe: expected.keyframe,
                presentationTimestampMs: expected.presentationTimestampMs
            )
            let wire = header + payload
            XCTAssertEqual(wire, try hexToData(expected.recordHex), "record \(name) bytes diverged")

            // DECODER: the same bytes surface as an encoded-video record, distinct
            // from a raw frame, with identical fields.
            guard let decodedHeader = FrameProtocol.decodeHeader(header) else {
                XCTFail("record \(name) header failed to decode")
                continue
            }
            XCTAssertTrue(FrameProtocol.isEncodedVideoHeader(decodedHeader))
            XCTAssertEqual(
                FrameProtocol.decodeEncodedVideoHeader(header),
                FrameProtocol.EncodedVideoRecord(
                    payloadLength: payload.count,
                    isKeyframe: expected.keyframe,
                    presentationTimestampMs: expected.presentationTimestampMs
                )
            )
        }
    }

    func testCorruptedEncodedHeaderFailsChecksum() throws {
        let golden = try loadGolden()
        let corrupted = try hexToData(golden.resync.corruptedRecordHex).prefix(FrameProtocol.headerSize)
        // A flipped field byte fails the CRC-32, so this is not a valid boundary.
        XCTAssertNil(FrameProtocol.decodeHeader(Data(corrupted)))
        XCTAssertNil(FrameProtocol.decodeEncodedVideoHeader(Data(corrupted)))
    }

    func testEncodedDiscriminatorDoesNotCollideWithAudioOrRaw() {
        // Audio sentinel: width=0, height=8000, bytesPerRow=1.
        let audio = FrameProtocol.Header(width: 0, height: 8_000, bytesPerRow: 1, timestampMs: 0)
        XCTAssertFalse(FrameProtocol.isEncodedVideoHeader(audio))
        // A real raw frame always has width >= 1.
        let raw = FrameProtocol.Header(width: 1170, height: 2532, bytesPerRow: 4680, timestampMs: 1)
        XCTAssertFalse(FrameProtocol.isEncodedVideoHeader(raw))
        // Both encoded sentinels (delta / keyframe) are recognized.
        let delta = FrameProtocol.Header(
            width: 0, height: FrameProtocol.encodedVideoHeightBase, bytesPerRow: 10, timestampMs: 5
        )
        let keyframe = FrameProtocol.Header(
            width: 0, height: FrameProtocol.encodedVideoHeightBase | 1, bytesPerRow: 10, timestampMs: 5
        )
        XCTAssertTrue(FrameProtocol.isEncodedVideoHeader(delta))
        XCTAssertTrue(FrameProtocol.isEncodedVideoHeader(keyframe))
    }
}
