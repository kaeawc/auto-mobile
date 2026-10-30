@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Device media items (#14192): the `{data}` image binding, the reserved `media:` prefix and the gate.
final class PrototypeMediaItemsTests: XCTestCase {
    private func spec(_ asset: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"data":{"photo":"media:1"},
         "root":{"type":"column","children":[
           {"type":"image","asset":\(asset),"contentDescription":"Photo"},
           {"type":"image","asset":"uploaded","contentDescription":"Logo"},
           {"type":"image","asset":"media:literal","contentDescription":"Literal"}]}}
        """.utf8))
    }

    func testADataBindingDecodesAndNamesNoUploadedAsset() throws {
        let value = try JSONDecoder().decode(PrototypeModeValue.self, from: Data(#"{"data":"/photo"}"#.utf8))
        XCTAssertEqual(value, .data("/photo"))
        XCTAssertEqual(value.values, [])
        XCTAssertEqual(value.value(dark: true), "")
        XCTAssertEqual(
            try JSONDecoder().decode(PrototypeModeValue.self, from: Data(#"{"light":"a","dark":"b"}"#.utf8)),
            .modes(light: "a", dark: "b")
        )
    }

    func testAMediaIdIsNeverReportedMissing() throws {
        var session = PrototypeSession()
        try session.show(spec(#"{"data":"/photo"}"#))
        XCTAssertEqual(session.missingAssets(available: []), ["uploaded"])
    }

    func testHostAssetIdsCannotUseTheReservedPrefix() {
        XCTAssertTrue(PrototypeMediaItems.isMediaId("media:5b1f"))
        XCTAssertFalse(PrototypeMediaItems.isMediaId("uploaded"))
        XCTAssertFalse(PrototypeMediaItems.isMediaId("my-media:x"))
    }

    func testTheGateCoversImageAssetsAndTabItems() throws {
        let image: [String: JSONValue] = ["type": .string("image"), "asset": .object(["data": .string("/photo")])]
        let plain: [String: JSONValue] = ["type": .string("image"), "asset": .string("uploaded")]
        let tabs: [String: JSONValue] = [
            "type": .string("tabBar"),
            "items": .array([.object(["label": .string("A"), "image": .object(["data": .string("/photo")])])]),
        ]
        XCTAssertTrue(PrototypeMediaItems.usedBy(image))
        XCTAssertFalse(PrototypeMediaItems.usedBy(plain))
        XCTAssertTrue(PrototypeMediaItems.usedBy(tabs))
        XCTAssertEqual(PrototypeMediaItems.capability, "prototype_platform_media_items_v1")
    }
}
