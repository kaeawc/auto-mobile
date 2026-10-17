@testable import AutoMobileSdkWire
import Foundation
import XCTest

/// Round-trips the real SDK hierarchy payloads captured in `test/fixtures/ios/merger-pairs`
/// (the `sdk` half of each runner input pair) through the shared models, so a drift between the
/// SDK that encodes them and the runner that decodes them fails here, in one place.
final class SdkHierarchyCodecTests: XCTestCase {
    private var pairsDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/ios/merger-pairs")
    }

    private func capturedHierarchies() throws -> [(name: String, json: Data, decoded: SdkViewHierarchy)] {
        let names = try FileManager.default.contentsOfDirectory(atPath: pairsDirectory.path)
            .filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertFalse(names.isEmpty)
        return try names.map { name in
            let pair = try JSONSerialization
                .jsonObject(with: Data(contentsOf: pairsDirectory.appendingPathComponent(name)))
            let sdk = try XCTUnwrap((pair as? [String: Any])?["sdk"], name)
            let json = try JSONSerialization.data(withJSONObject: sdk)
            return try (name, json, JSONDecoder().decode(SdkViewHierarchy.self, from: json))
        }
    }

    private func count(_ node: SdkViewNode?) -> Int {
        guard let node else { return 0 }
        return 1 + (node.children ?? []).reduce(0) { $0 + count($1) }
    }

    private func canonical(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    func testEveryCapturedSdkPayloadDecodesWithItsEnvelopeAndTree() throws {
        for capture in try capturedHierarchies() {
            let hierarchy = capture.decoded
            XCTAssertGreaterThan(hierarchy.screenWidth, 0, capture.name)
            XCTAssertGreaterThan(hierarchy.screenScale, 0, capture.name)
            XCTAssertGreaterThan(count(hierarchy.root), 1, capture.name)
            XCTAssertNotNil(hierarchy.safeAreaInsets, capture.name)
        }
    }

    func testEncodeThenDecodeIsAFixedPointForEveryCapture() throws {
        for capture in try capturedHierarchies() {
            let once = try canonical(capture.decoded)
            let again = try canonical(JSONDecoder().decode(SdkViewHierarchy.self, from: once))
            XCTAssertEqual(once, again, capture.name)
        }
    }

    func testTheEncodedFormKeepsEveryNodeAndItsBounds() throws {
        for capture in try capturedHierarchies() {
            let reencoded = try JSONDecoder().decode(
                SdkViewHierarchy.self, from: JSONEncoder().encode(capture.decoded)
            )
            XCTAssertEqual(count(reencoded.root), count(capture.decoded.root), capture.name)
            XCTAssertEqual(reencoded.root?.bounds, capture.decoded.root?.bounds, capture.name)
            XCTAssertEqual(reencoded.timestamp, capture.decoded.timestamp, capture.name)
        }
    }

    func testANodeFromAnOlderSdkDecodesWithTheDocumentedDefaults() throws {
        let node = try JSONDecoder().decode(
            SdkViewNode.self,
            from: Data(#"{"className":"UIView","bounds":{"left":1,"top":2,"right":11,"bottom":22}}"#.utf8)
        )
        XCTAssertEqual(node.bounds, SdkBounds(left: 1, top: 2, right: 11, bottom: 22))
        XCTAssertEqual(node.alpha, 1)
        XCTAssertTrue(node.isUserInteractionEnabled)
        XCTAssertFalse(node.isAccessibilityFocused)
        XCTAssertEqual(node.accessibilityTraits, [])
        XCTAssertNil(node.children)
        XCTAssertNil(node.semanticLinks)
    }

    func testAMissingRequiredFieldIsADecodingErrorNotASilentDefault() {
        XCTAssertThrowsError(try JSONDecoder().decode(SdkViewNode.self, from: Data(#"{"className":"UIView"}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(SdkBounds.self, from: Data(#"{"left":1}"#.utf8)))
    }

    func testBoundsExtentsSaturateInsteadOfTrappingOnOverflow() {
        let huge = SdkBounds(left: Int.min, top: Int.max, right: Int.max, bottom: Int.min)
        XCTAssertEqual(huge.width, Int.max)
        XCTAssertEqual(huge.height, Int.min)
        XCTAssertEqual(SdkBounds(left: 5, top: 9, right: 2, bottom: 1).width, -3)
        XCTAssertEqual(BoundsArithmetic.signedDifference(10, 4), 6)
    }

    func testSemanticLinksAndChromeSurviveARoundTrip() throws {
        let link = SdkSemanticLink(text: "Terms", occurrence: 1, start: 3, end: 8, centerX: 12.5, centerY: 40)
        let node = SdkViewNode(
            className: "UILabel", bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10), semanticLinks: [link]
        )
        let hierarchy = SdkViewHierarchy(
            timestamp: 7, bundleId: "dev.test", screenScale: 3, screenWidth: 390, screenHeight: 844,
            safeAreaInsets: SdkEdgeInsets(top: 47, right: 0, bottom: 34, left: 0),
            displayCutoutInfo: .unknown,
            systemChrome: SdkSystemChrome(visibility: "visible", statusBar: "default", source: "scene"),
            root: node
        )
        let decoded = try JSONDecoder().decode(SdkViewHierarchy.self, from: JSONEncoder().encode(hierarchy))
        XCTAssertEqual(decoded.root?.semanticLinks, [link])
        XCTAssertEqual(decoded.displayCutoutInfo?.classification, "unknown")
        XCTAssertEqual(decoded.systemChrome?.statusBar, "default")
        XCTAssertEqual(decoded.safeAreaInsets?.bottom, 34)
    }
}
