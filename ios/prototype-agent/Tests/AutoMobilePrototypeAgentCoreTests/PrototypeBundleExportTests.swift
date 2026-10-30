@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleExportTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
    }

    func testImportIdentityIgnoresResourceOrderAndRequires() {
        let first = PrototypeBundleAsset(mediaType: "image/png", bytes: Data([1]))
        let second = PrototypeBundleAsset(mediaType: "image/jpeg", bytes: Data([2]))
        let ids = [PrototypeBundleID("z"), PrototypeBundleID("a")]
        let forward = Dictionary(uniqueKeysWithValues: [(ids[0], first), (ids[1], second)])
        let reverse = Dictionary(uniqueKeysWithValues: [(ids[1], second), (ids[0], first)])
        let spec = Data("spec".utf8)
        XCTAssertEqual(
            PrototypeBundle(spec: spec, assets: forward, fonts: reverse, requires: []).importIdentity,
            PrototypeBundle(spec: spec, assets: reverse, fonts: forward, requires: ["advisory"]).importIdentity
        )
    }

    func testImportIdentityIncludesSpecAndEachResourceIDMediaTypeAndBytes() {
        let spec = Data("spec".utf8)
        for font in [false, true] {
            let original = PrototypeBundleAsset(mediaType: font ? "font/ttf" : "image/png", bytes: Data([1]))
            let variants: [(PrototypeBundleID, PrototypeBundleAsset)] = [
                (.init("other"), original),
                (.init("same"), .init(mediaType: font ? "font/otf" : "image/jpeg", bytes: original.bytes)),
                (.init("same"), .init(mediaType: original.mediaType, bytes: Data([2]))),
            ]
            let resources = [PrototypeBundleID("same"): original]
            let baseline = PrototypeBundle(
                spec: spec, assets: font ? [:] : resources, fonts: font ? resources : [:], requires: []
            )
            for (id, asset) in variants {
                let changed = [id: asset]
                XCTAssertNotEqual(baseline.importIdentity, PrototypeBundle(
                    spec: spec, assets: font ? [:] : changed, fonts: font ? changed : [:], requires: []
                ).importIdentity)
            }
            XCTAssertNotEqual(baseline.importIdentity, PrototypeBundle(
                spec: Data("changed".utf8), assets: baseline.assets, fonts: baseline.fonts, requires: []
            ).importIdentity)
        }
    }

    func testImportIdentitySeparatesImageAndFontGroupsEvenWithSameID() {
        let resources = [PrototypeBundleID("same"): PrototypeBundleAsset(mediaType: "image/png", bytes: Data([1]))]
        let image = PrototypeBundle(spec: Data(), assets: resources, fonts: [:], requires: [])
        let font = PrototypeBundle(spec: Data(), assets: [:], fonts: resources, requires: [])
        let both = PrototypeBundle(spec: Data(), assets: resources, fonts: resources, requires: [])
        XCTAssertNotEqual(image.importIdentity, font.importIdentity)
        XCTAssertNotEqual(both.importIdentity, image.importIdentity)
        XCTAssertNotEqual(both.importIdentity, font.importIdentity)
    }

    func testImportIdentityPreservesExactUnicodeIDBytesAndFieldBoundaries() {
        let asset = PrototypeBundleAsset(mediaType: "image/png", bytes: Data([1]))
        let composed = PrototypeBundle(spec: Data(), assets: [.init("\u{e9}"): asset], fonts: [:], requires: [])
        let decomposed = PrototypeBundle(spec: Data(), assets: [.init("e\u{301}"): asset], fonts: [:], requires: [])
        XCTAssertNotEqual(composed.importIdentity, decomposed.importIdentity)
        let first = PrototypeBundle(
            spec: Data(), assets: [.init("a:b"): .init(mediaType: "c", bytes: Data([1]))], fonts: [:], requires: []
        )
        let second = PrototypeBundle(
            spec: Data(), assets: [.init("a"): .init(mediaType: "b:c", bytes: Data([1]))], fonts: [:], requires: []
        )
        XCTAssertNotEqual(first.importIdentity, second.importIdentity)
    }

    func testUploadAssetReferencesSkipOpaqueLiterals() throws {
        let data = Data(#"""
        {"id":"uploads","window":{"placement":{"type":"fullscreen"}},
         "data":{"body":{"file":{"asset":"opaque-data"}}},
         "root":{"type":"button","label":"Upload","onTap":[
           {"type":"request","method":"POST","url":"https://example.com/upload",
            "body":{"file":{"asset":"raw"},"contentType":"image/png"},
            "onSuccess":[{"type":"request","method":"POST","url":"https://example.com/upload",
              "body":{"multipart":[{"name":"photo","file":{"asset":"part"}},
                {"name":"text","value":{"value":{"file":{"asset":"opaque-part"}}}}]}}]},
           {"type":"request","method":"POST","url":"https://example.com/upload",
            "body":{"value":{"file":{"asset":"opaque-body"}}}}]}}
        """#.utf8)
        let refs = try PrototypeBundleReferences(data)
        XCTAssertEqual(Set(refs.images.map(\.string)), ["raw", "part"])
        XCTAssertTrue(refs.fonts.isEmpty)
    }

    func testMissingFontExportUsesReferenceAssetMissingCode() throws {
        let fixture = try XCTUnwrap(PrototypeBundleFixtures.corpus.get().cases[1].exportInputs)
        let input = PrototypeBundleExportInput(
            spec: fixture.specBase64,
            assets: fixture.input.assets,
            fonts: { _ in nil }
        )
        XCTAssertThrowsError(try PrototypeBundle.export(input)) {
            XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.assetMissing, "font"))
        }
    }

    func testLookupFailureMapsToClosedVocabulary() throws {
        enum LookupFailure: Error { case unavailable }
        let fixture = try XCTUnwrap(PrototypeBundleFixtures.corpus.get().cases[1].exportInputs)
        let input = PrototypeBundleExportInput(
            spec: fixture.specBase64,
            assets: { _ in throw LookupFailure.unavailable },
            fonts: { _ in nil }
        )
        XCTAssertThrowsError(try PrototypeBundle.export(input)) {
            XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.assetMissing))
        }
    }

    func testWrongMediaMagicRejectsBeforeSerialization() throws {
        let fixture = try XCTUnwrap(PrototypeBundleFixtures.corpus.get().cases[1].exportInputs)
        let input = PrototypeBundleExportInput(
            spec: fixture.specBase64,
            assets: { _ in .init(mediaType: "image/png", bytes: Data([0])) },
            fonts: fixture.input.fonts
        )
        XCTAssertThrowsError(try PrototypeBundle.export(input)) {
            XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.assetTypeMismatch, "image"))
        }
    }

    func testRequiresUsesAuthoredFeatureSlotsAndSkipsOpaqueData() throws {
        let json =
            Data(
                #"{"data":{"fake":{"type":"request"}},"root":{"type":"column","children":[{"type":"text","text":"{data:/name}","style":{"runSpacing":2}},{"type":"scroll","reverse":true,"onTap":[{"type":"emit","name":"sample","payload":{"type":"platform","call":"test.echo"}}]}]}}"#
                    .utf8
            )
        XCTAssertEqual(try PrototypeBundleCapabilities.required(json), [
            "prototype_chat_scroll_v1", "prototype_data_model_v1", "prototype_flow_grid_v1",
        ])
    }

    func testLiteralRepeatDoesNotRequireDataModelAndPlatformDeclarationsUseContractModules() throws {
        let json =
            Data(
                #"{"requires":{"platform":["test"]},"root":{"type":"text","text":"x","repeat":{"items":[{"name":"x"}],"as":"row"}}}"#
                    .utf8
            )
        XCTAssertEqual(
            try PrototypeBundleCapabilities.required(json),
            ["prototype_platform_test_v1", "prototype_platform_v1"]
        )
    }

    func testEmptyRepeatStillRequiresAuthoredImageAsset() {
        let spec =
            Data(
                #"{"id":"empty-repeat","window":{"placement":{"type":"fullscreen"}},"data":{"rows":[]},"root":{"type":"column","repeat":{"items":{"path":"/rows"},"as":"row"},"children":[{"type":"image","asset":"image"}]}}"#
                    .utf8
            )
        let input = PrototypeBundleExportInput(spec: spec, assets: { _ in nil }, fonts: { _ in nil })
        XCTAssertThrowsError(try PrototypeBundle.export(input)) {
            XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.assetMissing, "image"))
        }
    }

    func testWholeFileCapRejectsBeforeZIPParsing() {
        XCTAssertThrowsError(try PrototypeBundle.read(Data(
            repeating: 0,
            count: PrototypeBundle.maxCompressedBytes + 1
        ))) {
            XCTAssertEqual($0 as? PrototypeBundleFailure, .init(.archiveTooLarge))
        }
    }
}
