import XCTest
@testable import ScreenCaptureCore

/// Pure tests for the avcC -> Annex-B conversion and SPS/PPS-on-IDR assembly
/// (issue #4788), including a byte-for-byte pin against #4787's shared encoded
/// record golden vectors: an avcC-wrapped golden NAL converts to the golden
/// Annex-B payload, and the assembled record equals the golden record bytes.
final class AnnexBConverterTests: XCTestCase {
    private func hex(_ string: String) -> Data {
        var data = Data(capacity: string.count / 2)
        var index = string.startIndex
        while index < string.endIndex {
            let next = string.index(index, offsetBy: 2)
            // Test fixtures are trusted; a bad byte should fail the test loudly.
            data.append(UInt8(string[index..<next], radix: 16)!)  // swiftlint:disable:this force_unwrapping
            index = next
        }
        return data
    }

    /// Wrap a raw NAL (no prefix) as a single avcC unit with a 4-byte length.
    private func avcc4(_ nal: Data) -> Data {
        let length = UInt32(nal.count).bigEndian
        var out = withUnsafeBytes(of: length) { Data($0) }
        out.append(nal)
        return out
    }

    func testSingleNalConversion() throws {
        let nal = hex("6742001fabcdef")
        let converted = try AnnexBConverter.annexB(fromAvcc: avcc4(nal), nalUnitHeaderLength: 4)
        XCTAssertEqual(converted, AnnexBConverter.startCode + nal)
    }

    func testMultiNalConversion() throws {
        let first = hex("6742001f")
        let second = hex("68ce3c80")
        let third = hex("419a0102")
        let sample = avcc4(first) + avcc4(second) + avcc4(third)
        let converted = try AnnexBConverter.annexB(fromAvcc: sample, nalUnitHeaderLength: 4)
        XCTAssertEqual(
            converted,
            AnnexBConverter.startCode + first
                + AnnexBConverter.startCode + second
                + AnnexBConverter.startCode + third
        )
    }

    func testHonorsTwoByteNalHeaderLength() throws {
        let nal = hex("419a0102030405")
        var sample = Data([0x00, UInt8(nal.count)])  // 2-byte big-endian length
        sample.append(nal)
        let converted = try AnnexBConverter.annexB(fromAvcc: sample, nalUnitHeaderLength: 2)
        XCTAssertEqual(converted, AnnexBConverter.startCode + nal)
    }

    func testConversionOnSliceWithNonZeroStartIndex() throws {
        // A `Data` slice whose indices do not start at 0 must convert correctly.
        let nal = hex("6742001f")
        let padded = Data([0xAA, 0xBB]) + avcc4(nal)
        let slice = padded[padded.index(padded.startIndex, offsetBy: 2)...]
        let converted = try AnnexBConverter.annexB(fromAvcc: slice, nalUnitHeaderLength: 4)
        XCTAssertEqual(converted, AnnexBConverter.startCode + nal)
    }

    func testInvalidNalHeaderLengthThrows() {
        XCTAssertThrowsError(try AnnexBConverter.annexB(fromAvcc: Data([0, 0, 0, 1, 5]), nalUnitHeaderLength: 0)) {
            XCTAssertEqual($0 as? AnnexBConverter.ConversionError, .invalidNalHeaderLength(0))
        }
        XCTAssertThrowsError(try AnnexBConverter.annexB(fromAvcc: Data(), nalUnitHeaderLength: 5)) {
            XCTAssertEqual($0 as? AnnexBConverter.ConversionError, .invalidNalHeaderLength(5))
        }
    }

    func testTruncatedSampleThrows() {
        // Length prefix claims 10 bytes but only 2 follow.
        let sample = Data([0x00, 0x00, 0x00, 0x0A, 0x01, 0x02])
        XCTAssertThrowsError(try AnnexBConverter.annexB(fromAvcc: sample, nalUnitHeaderLength: 4)) {
            XCTAssertEqual($0 as? AnnexBConverter.ConversionError, .truncatedSample)
        }
    }

    func testParameterSetsPrependedOnKeyframeOnly() throws {
        let sps = hex("6742001f")
        let pps = hex("68ce3c80")
        let idr = hex("65010203")
        let sample = avcc4(idr)

        let keyframe = try AnnexBConverter.assembleAccessUnit(
            fromAvcc: sample, nalUnitHeaderLength: 4, parameterSets: [sps, pps], isKeyframe: true
        )
        XCTAssertEqual(
            keyframe,
            AnnexBConverter.startCode + sps + AnnexBConverter.startCode + pps
                + AnnexBConverter.startCode + idr
        )

        // A delta frame does NOT get parameter sets even if provided.
        let delta = try AnnexBConverter.assembleAccessUnit(
            fromAvcc: sample, nalUnitHeaderLength: 4, parameterSets: [sps, pps], isKeyframe: false
        )
        XCTAssertEqual(delta, AnnexBConverter.startCode + idr)
    }

    // MARK: - #4787 golden-vector pin

    private struct GoldenRecord: Decodable {
        let name: String
        let keyframe: Bool
        let presentationTimestampMs: UInt32
        let payloadHex: String
        let recordHex: String
    }

    private struct Golden: Decodable {
        let records: [GoldenRecord]
    }

    private func loadGolden() throws -> Golden {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixture = root
            .appendingPathComponent("test").appendingPathComponent("fixtures")
            .appendingPathComponent("encoded-h264-golden-vectors.json")
        return try JSONDecoder().decode(Golden.self, from: try Data(contentsOf: fixture))
    }

    /// Each golden payload is Annex-B `00000001` + a single NAL. Wrapping that
    /// NAL as avcC and converting must reproduce the golden payload exactly, and
    /// the assembled `FrameProtocol` record must equal the golden record bytes.
    func testGoldenRecordsRebuiltFromAvcc() throws {
        let golden = try loadGolden()
        for record in golden.records {
            let annexBPayload = hex(record.payloadHex)
            let nal = annexBPayload.dropFirst(AnnexBConverter.startCode.count)
            let sample = avcc4(Data(nal))

            let converted = try AnnexBConverter.assembleAccessUnit(
                fromAvcc: sample, nalUnitHeaderLength: 4, parameterSets: [], isKeyframe: record.keyframe
            )
            XCTAssertEqual(converted, annexBPayload, "avcC->Annex-B diverged for \(record.name)")

            let header = FrameProtocol.encodeEncodedVideoHeader(
                payloadLength: converted.count,
                isKeyframe: record.keyframe,
                presentationTimestampMs: record.presentationTimestampMs
            )
            XCTAssertEqual(header + converted, hex(record.recordHex), "record bytes diverged for \(record.name)")
        }
    }
}
