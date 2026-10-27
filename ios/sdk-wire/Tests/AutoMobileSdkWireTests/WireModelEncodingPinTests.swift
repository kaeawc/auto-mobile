@testable import AutoMobileSdkWire
import Foundation
import XCTest

/// Pins what the shared models put on the wire. The CtrlProxy runner and the in-app SDK now share one
/// declaration, so an accidental change (a renamed property, a defaulted field that starts being emitted,
/// an optional that stops being omitted) would silently change both ends at once and no cross-package
/// test would notice. The expectations come from the real SDK payloads captured in
/// `test/fixtures/ios/merger-pairs` rather than from literals the encoder trivially satisfies.
final class WireModelEncodingPinTests: XCTestCase {
    private var pairsDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/ios/merger-pairs")
    }

    private func capturedSdkPayloads() throws -> [(name: String, object: [String: Any], data: Data)] {
        let names = try FileManager.default.contentsOfDirectory(atPath: pairsDirectory.path)
            .filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertFalse(names.isEmpty)
        return try names.map { name in
            let pair = try JSONSerialization
                .jsonObject(with: Data(contentsOf: pairsDirectory.appendingPathComponent(name)))
            let sdk = try XCTUnwrap((pair as? [String: Any])?["sdk"] as? [String: Any], name)
            return try (name, sdk, JSONSerialization.data(withJSONObject: sdk))
        }
    }

    private func reencoded(_ data: Data) throws -> [String: Any] {
        let hierarchy = try JSONDecoder().decode(SdkViewHierarchy.self, from: data)
        let encoded = try JSONEncoder().encode(hierarchy)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    }

    /// Every node key the real SDK emitted must come back out, and the encoder must not invent keys the
    /// SDK never sent: the captured key sets are the contract.
    private func assertSameKeys(
        _ captured: [String: Any], _ encoded: [String: Any], path: String, file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(Set(captured.keys), Set(encoded.keys), path, file: file, line: line)
        let capturedKids = captured["children"] as? [[String: Any]] ?? []
        let encodedKids = encoded["children"] as? [[String: Any]] ?? []
        XCTAssertEqual(capturedKids.count, encodedKids.count, path, file: file, line: line)
        for (index, pair) in zip(capturedKids, encodedKids).enumerated() {
            assertSameKeys(pair.0, pair.1, path: "\(path)/\(index)", file: file, line: line)
        }
    }

    func testReencodingEveryCapturedPayloadKeepsTheExactNodeKeySets() throws {
        for capture in try capturedSdkPayloads() {
            let encoded = try reencoded(capture.data)
            XCTAssertEqual(Set(capture.object.keys), Set(encoded.keys), capture.name)
            let capturedRoot = try XCTUnwrap(capture.object["root"] as? [String: Any], capture.name)
            let encodedRoot = try XCTUnwrap(encoded["root"] as? [String: Any], capture.name)
            assertSameKeys(capturedRoot, encodedRoot, path: "\(capture.name):root")
        }
    }

    /// Compares one canonical (sorted-key) serialization per capture instead of deeply comparing the
    /// bridged object graphs: same intent (every scalar value survives the round trip), linear time.
    func testReencodingEveryCapturedPayloadPreservesEveryScalarValue() throws {
        for capture in try capturedSdkPayloads() {
            let canonicalCaptured = try canonical(capture.object)
            let canonicalEncoded = try canonical(reencoded(capture.data))
            XCTAssertTrue(
                canonicalCaptured == canonicalEncoded,
                "\(capture.name): re-encoding changed a value on the wire"
            )
        }
    }

    private func canonical(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    func testOptionalFieldsAreOmittedNotEncodedAsNull() throws {
        let bare = SdkViewNode(className: "UIView", bounds: SdkBounds(left: 0, top: 0, right: 1, bottom: 1))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(bare)) as? [String: Any]
        )
        for key in [
            "accessibilityLabel",
            "accessibilityIdentifier",
            "backgroundColor",
            "borderColor",
            "semanticLinks",
            "children",
        ] {
            XCTAssertNil(object[key], key)
        }
        XCTAssertFalse(try XCTUnwrap(String(data: JSONEncoder().encode(bare), encoding: .utf8)).contains("null"))
        let empty = SdkViewHierarchy(
            timestamp: 0,
            bundleId: nil,
            screenScale: 1,
            screenWidth: 1,
            screenHeight: 1,
            root: nil
        )
        let hierarchy = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(empty)) as? [String: Any]
        )
        XCTAssertEqual(Set(hierarchy.keys), ["timestamp", "screenScale", "screenWidth", "screenHeight"])
    }
}
