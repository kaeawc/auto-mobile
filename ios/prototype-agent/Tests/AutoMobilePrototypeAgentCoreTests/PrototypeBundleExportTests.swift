@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleExportTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
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
