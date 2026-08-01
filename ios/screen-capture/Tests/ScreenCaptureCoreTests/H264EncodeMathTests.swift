import XCTest
@testable import ScreenCaptureCore

/// Pins the in-helper H.264 resolution/bitrate arithmetic (issue #4788) against
/// the shared golden vectors in `test/fixtures/h264-level42-scale-golden-vectors.json`.
/// The TypeScript sender (`resolveIosEncoderScale`, `defaultIosBitrateBps`,
/// `WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME`) reproduces the SAME fixture, so the
/// cross-language Level 4.2 macroblock budget advertised in the WHIP SDP cannot
/// drift from what this helper actually encodes.
final class H264EncodeMathTests: XCTestCase {
    private struct Scaled: Decodable {
        let width: Int
        let height: Int
    }

    private struct ScaleCase: Decodable {
        let width: Int
        let height: Int
        let scaled: Scaled?
        let macroblocks: Int
    }

    private struct BitrateCase: Decodable {
        let width: Int
        let height: Int
        let fps: Int
        let bitrateBps: Int
    }

    private struct Golden: Decodable {
        let maxMacroblocksPerFrame: Int
        let macroblockSize: Int
        let minEncoderDimension: Int
        let defaultBitsPerPixel: Double
        let scaleCases: [ScaleCase]
        let bitrateCases: [BitrateCase]
    }

    private func loadGolden() throws -> Golden {
        // <repo>/ios/screen-capture/Tests/ScreenCaptureCoreTests/<thisFile>.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixture = root
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent("h264-level42-scale-golden-vectors.json")
        let data = try Data(contentsOf: fixture)
        return try JSONDecoder().decode(Golden.self, from: data)
    }

    /// The Level 4.2 macroblock budget and the other cross-language constants
    /// MUST equal what the fixture (generated from the TS constants) encodes.
    func testConstantsMatchFixture() throws {
        let golden = try loadGolden()
        XCTAssertEqual(H264EncodeMath.maxMacroblocksPerFrame, golden.maxMacroblocksPerFrame)
        XCTAssertEqual(H264EncodeMath.macroblockSize, golden.macroblockSize)
        XCTAssertEqual(H264EncodeMath.minEncoderDimension, golden.minEncoderDimension)
        XCTAssertEqual(H264EncodeMath.defaultBitsPerPixel, golden.defaultBitsPerPixel, accuracy: 1e-12)
    }

    /// Every scale case resolves to the same size (and the same macroblock count)
    /// as the TypeScript `resolveIosEncoderScale`.
    func testScaleCasesMatchFixture() throws {
        let golden = try loadGolden()
        for testCase in golden.scaleCases {
            XCTAssertEqual(
                H264EncodeMath.macroblocksPerFrame(width: testCase.width, height: testCase.height),
                testCase.macroblocks,
                "macroblocks diverged for \(testCase.width)x\(testCase.height)"
            )
            let resolved = H264EncodeMath.resolveEncoderScale(
                H264EncodeMath.EncoderSize(width: testCase.width, height: testCase.height)
            )
            if let scaled = testCase.scaled {
                XCTAssertEqual(
                    resolved,
                    H264EncodeMath.EncoderSize(width: scaled.width, height: scaled.height),
                    "scale diverged for \(testCase.width)x\(testCase.height)"
                )
            } else {
                XCTAssertNil(resolved, "expected native size for \(testCase.width)x\(testCase.height)")
            }
        }
    }

    /// Every scaled result is even (4:2:0) and inside the Level 4.2 budget.
    func testScaledResultsAreEvenAndWithinBudget() throws {
        let golden = try loadGolden()
        for testCase in golden.scaleCases {
            let resolved = H264EncodeMath.resolveEncoderScale(
                H264EncodeMath.EncoderSize(width: testCase.width, height: testCase.height)
            ) ?? H264EncodeMath.EncoderSize(width: testCase.width, height: testCase.height)
            XCTAssertEqual(resolved.width % 2, 0)
            XCTAssertEqual(resolved.height % 2, 0)
            XCTAssertLessThanOrEqual(
                H264EncodeMath.macroblocksPerFrame(width: resolved.width, height: resolved.height),
                H264EncodeMath.maxMacroblocksPerFrame
            )
        }
    }

    /// The bits-per-pixel -> bitrate arithmetic matches `defaultIosBitrateBps`
    /// (via the default budget) and the general `bitrateBps` (with that budget).
    func testBitrateCasesMatchFixture() throws {
        let golden = try loadGolden()
        for testCase in golden.bitrateCases {
            let size = H264EncodeMath.EncoderSize(width: testCase.width, height: testCase.height)
            XCTAssertEqual(
                H264EncodeMath.defaultBitrateBps(size: size, fps: testCase.fps),
                testCase.bitrateBps,
                "default bitrate diverged for \(testCase.width)x\(testCase.height)@\(testCase.fps)"
            )
            XCTAssertEqual(
                H264EncodeMath.bitrateBps(
                    width: testCase.width, height: testCase.height,
                    fps: testCase.fps, bitsPerPixel: golden.defaultBitsPerPixel
                ),
                testCase.bitrateBps
            )
        }
    }

    func testBitrateFloorsAtOne() {
        // A zero-area frame still returns the positive floor rather than 0.
        XCTAssertEqual(
            H264EncodeMath.bitrateBps(width: 0, height: 100, fps: 30, bitsPerPixel: 0.1),
            1
        )
    }

    // MARK: - Source-aware bitrate resolution (issue #4790)

    /// An explicit operator override is honored verbatim on BOTH sources — the
    /// #4375 decision to always respect `--bitrate-bps`.
    func testResolveExplicitBpsHonoredForBothSources() {
        for source in [H264EncodeMath.CaptureSource.simulator, .device] {
            XCTAssertEqual(
                H264EncodeMath.resolveAverageBitRateBps(
                    source: source, bitrate: .explicitBps(2_500_000),
                    width: 800, height: 600, fps: 30
                ),
                2_500_000,
                "explicit bps must be honored for \(source)"
            )
        }
    }

    /// On the Simulator the bits-per-pixel budget is applied — same arithmetic as
    /// the pure `bitrateBps`.
    func testResolveBitsPerPixelAppliedForSimulator() {
        let resolved = H264EncodeMath.resolveAverageBitRateBps(
            source: .simulator, bitrate: .bitsPerPixel(0.1),
            width: 800, height: 600, fps: 30
        )
        XCTAssertEqual(
            resolved,
            H264EncodeMath.bitrateBps(width: 800, height: 600, fps: 30, bitsPerPixel: 0.1)
        )
    }

    /// The key #4790 branch: on a physical device the bits-per-pixel budget is
    /// SKIPPED (it was measured from Simulator screen content, #4349), so the
    /// resolver returns `nil` and VideoToolbox picks its own default.
    func testResolveBitsPerPixelSkippedForDevice() {
        XCTAssertNil(
            H264EncodeMath.resolveAverageBitRateBps(
                source: .device, bitrate: .bitsPerPixel(0.1),
                width: 800, height: 600, fps: 30
            )
        )
    }

    /// Neither flag leaves the VideoToolbox default (`nil`) on both sources.
    func testResolveVideoToolboxDefaultIsNilForBothSources() {
        for source in [H264EncodeMath.CaptureSource.simulator, .device] {
            XCTAssertNil(
                H264EncodeMath.resolveAverageBitRateBps(
                    source: source, bitrate: .videoToolboxDefault,
                    width: 800, height: 600, fps: 30
                ),
                "videoToolboxDefault must resolve to nil for \(source)"
            )
        }
    }
}
