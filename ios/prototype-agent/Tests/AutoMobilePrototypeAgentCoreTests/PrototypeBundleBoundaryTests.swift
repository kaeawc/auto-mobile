@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleBoundaryTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
    }

    func testSharedLimitsAndClosedVocabulary() throws {
        let corpus = try PrototypeBundleFixtures.corpus.get()
        XCTAssertEqual(PrototypeBundleCode.allCases.map(\.rawValue), corpus.errorCodes)
        XCTAssertEqual(corpus.caps, [
            "entries": PrototypeBundle.maxEntries,
            "spec": PrototypeBundle.maxSpecBytes,
            "manifest": PrototypeBundle.maxManifestBytes,
            "expanded": PrototypeBundle.maxExpandedBytes,
            "compressed": PrototypeBundle.maxCompressedBytes,
            "ratio": PrototypeBundle.maxRatio,
        ])
        let limits = PrototypeBundle.assetLimits
        XCTAssertEqual(corpus.contractLimits, [
            "MAX_PROTOTYPE_ASSET_BYTES": limits.maxImageBytes,
            "MAX_PROTOTYPE_FONT_ASSET_BYTES": limits.maxFontBytes,
            "MAX_PROTOTYPE_SHADER_ASSET_BYTES": limits.maxShaderBytes,
            "MAX_PROTOTYPE_ASSET_COUNT": limits.maxAssetCount,
            "MAX_PROTOTYPE_ASSET_TOTAL_BYTES": limits.maxTotalBytes,
            "MAX_PROTOTYPE_ASSET_ID_LENGTH": limits.maxIdLength,
        ])
    }

    private func truncations(_ start: Int, _ end: Int) throws {
        let bytes = try PrototypeBundleFixtures.corpus.get().cases[0].bundleBase64
        for offset in start ..< min(end, bytes.count) {
            XCTAssertThrowsError(try PrototypeBundle.read(Data(bytes.prefix(offset))), "offset \(offset)") {
                XCTAssertNotNil($0 as? PrototypeBundleFailure)
            }
        }
    }

    func testTruncationOffsets0Through63() throws { try truncations(0, 64) }
    func testTruncationOffsets64Through127() throws { try truncations(64, 128) }
    func testTruncationOffsets128Through191() throws { try truncations(128, 192) }
    func testTruncationOffsets192Through255() throws { try truncations(192, 256) }
    func testTruncationOffsets256Through319() throws { try truncations(256, 320) }
    func testTruncationOffsets320Through383() throws { try truncations(320, 384) }
    func testTruncationOffsets384Through447() throws { try truncations(384, 448) }
    func testTruncationOffsets448Through458() throws { try truncations(448, 512) }
}
