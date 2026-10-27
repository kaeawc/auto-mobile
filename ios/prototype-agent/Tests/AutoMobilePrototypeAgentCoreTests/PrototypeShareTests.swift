@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeShareTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        // Contract loading is outside each test's 100ms budget, as in the Kotlin runner.
        let spec =
            #"{"id":"warm","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["share"]},"root":{"type":"button","label":"Share","onTap":[{"type":"platform","call":"share.open","args":{"text":{"value":"warm"}}}]}}"#
        try? PrototypeSpecStrictValidator.validate(data: Data(spec.utf8))
    }

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures")
    }

    func testSharedResolver() throws {
        let raw = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("prototype-share.json"))
        )
        guard case let .array(cases) = raw else { return XCTFail("Expected fixture array") }
        for fixture in cases {
            let fields = fixture.objectFields!
            XCTAssertEqual(
                PrototypeShare
                    .resolvePrototypeShare(fields["args"]!.objectFields!, inputs: fields["inputs"]!.objectFields!).json,
                fields["expected"],
                fields["name"]!.stringValue!
            )
        }
    }

    func testRepeatedShareScanHasByteBudget() throws {
        let fixture = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(
                contentsOf: fixtures
                    .appendingPathComponent("prototype-spec/invalid/share-secure-scan-budget.json")
            )
        ).objectFields!
        let data = try JSONEncoder().encode(fixture["spec"]!)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data, library: true)) { error in
            XCTAssertEqual(
                error as? PrototypeLoadError,
                .invalidSpec(
                    path: fixture["expectedPath"]!.stringValue!,
                    message: fixture["expectedMessage"]!.stringValue!
                )
            )
        }
    }

    func testValidShareCorpus() throws {
        let folder = fixtures.appendingPathComponent("prototype-spec/valid")
        for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            where file.lastPathComponent.hasPrefix("share-")
        {
            let data = try Data(contentsOf: file)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), file.lastPathComponent)
            let spec = try JSONDecoder().decode(JSONValue.self, from: data).objectFields!
            XCTAssertTrue(
                PrototypeStrictCapabilities.required(spec).contains("prototype_platform_share_v1"),
                file.lastPathComponent
            )
            XCTAssertTrue(
                try PrototypeBundleCapabilities.required(data).contains("prototype_platform_share_v1"),
                file.lastPathComponent
            )
        }
    }

    func testInvalidShareCorpusFirst() throws { try invalidShareCorpus(shard: 0) }
    func testInvalidShareCorpusSecond() throws { try invalidShareCorpus(shard: 1) }
    func testInvalidShareCorpusThird() throws { try invalidShareCorpus(shard: 2) }
    private func invalidShareCorpus(shard: Int) throws {
        let folder = fixtures.appendingPathComponent("prototype-spec/invalid")
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("share-") }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        for (index, file) in files.enumerated() where index % 3 == shard {
            let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields!
            let options = fixture["options"]?.objectFields ?? [:]
            let supported = options["supportedCapabilities"].map { Set(PrototypeContractValidator.strings($0)) }
            let assets = options["shareAssetIds"].map { Set(PrototypeContractValidator.strings($0)) }
            let data = try JSONEncoder().encode(fixture["spec"]!)
            XCTAssertThrowsError(
                try PrototypeSpecStrictValidator
                    .validate(
                        data: data,
                        supportedCapabilities: supported,
                        library: options["library"] == .bool(true),
                        shareAssetIds: assets
                    ),
                file.lastPathComponent
            ) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(
                        path: fixture["expectedPath"]!.stringValue!,
                        message: fixture["expectedMessage"]!.stringValue!
                    ),
                    file.lastPathComponent
                )
            }
        }
    }
}
