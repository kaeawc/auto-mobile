@testable import AutoMobilePrototypeAgentCore
import CryptoKit
import Foundation
import XCTest

final class PrototypeSavedLayoutTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Asset: Decodable {
            let id: String
            let mediaType: String
            let base64: String
        }

        struct Expected: Decodable {
            let manifest: JSONValue
            let files: [String: String]
        }

        let formatVersion: Int
        let specJson: String
        let assets: [Asset]
        let expected: Expected
    }

    private var directory = URL(fileURLWithPath: NSTemporaryDirectory())
    private var fixture: Fixture?
    private var repository: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        let data = try Data(
            contentsOf: repository
                .appendingPathComponent("test/fixtures/prototype-saved-layout/layout.json")
        )
        let decoded = try JSONDecoder().decode(Fixture.self, from: data)
        fixture = decoded
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try writeManifest(decoded.expected.manifest)
        try Data(decoded.specJson.utf8).write(to: directory.appendingPathComponent("spec.json"))
        for asset in decoded.assets {
            let bytes = try XCTUnwrap(Data(base64Encoded: asset.base64))
            let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let path = try XCTUnwrap(decoded.expected.files.first { $0.value == hash }?.key)
            let url = directory.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try bytes.write(to: url)
        }
    }

    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    private func writeManifest(_ manifest: JSONValue) throws {
        try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent("manifest.json"))
    }

    private func mutateManifest(_ mutate: (inout [String: JSONValue]) -> Void) throws {
        let data = try Data(contentsOf: directory.appendingPathComponent("manifest.json"))
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        guard case var .object(fields) = value else { return XCTFail("Expected object") }
        mutate(&fields)
        try writeManifest(.object(fields))
    }

    private func mutateEntry(_ key: String = "assets", _ mutate: (inout [String: JSONValue]) -> Void) throws {
        try mutateManifest { fields in
            guard case var .array(entries) = fields[key], let first = entries.first,
                  case var .object(record) = first else { return XCTFail("Expected record") }
            mutate(&record)
            entries[0] = .object(record)
            fields[key] = .array(entries)
        }
    }

    private func imageURL() throws -> URL {
        let decoded = try XCTUnwrap(fixture)
        let path = try XCTUnwrap(decoded.expected.files.keys.first { $0.hasPrefix("assets/") })
        return directory.appendingPathComponent(path)
    }

    private func loaded(_ limits: PrototypeSavedLayoutLimits = PrototypeSavedLayoutLimits()) throws
        -> PrototypeSavedPrototype
    {
        let result = PrototypeSavedLayoutReader(limits: limits).load(directory: directory)
        guard case let .loaded(value) = result else {
            XCTFail("Expected loaded, got \(result)")
            throw NSError(domain: "Test", code: 1)
        }
        return value
    }

    private func assertCorrupt(_ limits: PrototypeSavedLayoutLimits = PrototypeSavedLayoutLimits()) {
        guard case .corrupt = PrototypeSavedLayoutReader(limits: limits).load(directory: directory)
        else { return XCTFail("Expected corrupt") }
    }

    func testSharedFixtureAndConstants() throws {
        let decoded = try XCTUnwrap(fixture)
        let value = try loaded()
        XCTAssertTrue(value.problems.isEmpty)
        XCTAssertEqual(Set(value.assets.keys), Set(decoded.assets.map(\.id)))
        XCTAssertEqual(value.specData, Data(decoded.specJson.utf8))
        for asset in decoded.assets {
            let verified = try XCTUnwrap(value.assets[asset.id])
            XCTAssertEqual(verified.data, Data(base64Encoded: asset.base64))
            XCTAssertEqual(verified.mediaType, asset.mediaType)
            XCTAssertEqual(verified.isFont, asset.mediaType.hasPrefix("font/"))
            XCTAssertEqual(
                verified.sha256,
                SHA256.hash(data: verified.data).map { String(format: "%02x", $0) }.joined()
            )
        }
        let contract = try JSONSerialization.jsonObject(
            with: Data(contentsOf: repository.appendingPathComponent("schemas/prototype-asset-contract.json"))
        ) as? [String: Any]
        let caps = try XCTUnwrap(contract?["limits"] as? [String: Int])
        let limits = PrototypeSavedLayoutLimits()
        XCTAssertEqual(PrototypeSavedLayout.formatVersion, decoded.formatVersion)
        XCTAssertEqual(limits.maxImageBytes, caps["MAX_PROTOTYPE_ASSET_BYTES"])
        XCTAssertEqual(limits.maxFontBytes, caps["MAX_PROTOTYPE_FONT_ASSET_BYTES"])
        XCTAssertEqual(limits.maxShaderBytes, caps["MAX_PROTOTYPE_SHADER_ASSET_BYTES"])
        XCTAssertEqual(limits.maxAssetCount, caps["MAX_PROTOTYPE_ASSET_COUNT"])
        XCTAssertEqual(limits.maxTotalBytes, caps["MAX_PROTOTYPE_ASSET_TOTAL_BYTES"])
        XCTAssertEqual(limits.maxIdLength, caps["MAX_PROTOTYPE_ASSET_ID_LENGTH"])
        XCTAssertEqual(limits.maxSpecBytes, PrototypeLimits.maxSpecBytes)
        XCTAssertEqual(limits.maxManifestBytes, 262_144)
    }

    private func assertImageProblem(_ kind: PrototypeSavedProblemKind) throws {
        let value = try loaded()
        XCTAssertNil(value.assets["image-a"])
        XCTAssertNil(value.assets["image-b"])
        XCTAssertNotNil(value.assets["font-a"])
        XCTAssertEqual(value.problems.map(\.assetId), ["image-a", "image-b"])
        XCTAssertEqual(value.problems.map(\.kind), [kind, kind])
        XCTAssertTrue(value.problems[0].description.hasPrefix("image-a: \(kind.rawValue):"))
    }

    func testMissingAsset() throws {
        try FileManager.default.removeItem(at: imageURL())
        try assertImageProblem(.missing)
    }

    func testTamperedAndTruncatedAssets() throws {
        try Data([1]).write(to: imageURL())
        try assertImageProblem(.hashMismatch)
    }

    func testEmptyAsset() throws {
        try Data().write(to: imageURL())
        try assertImageProblem(.oversized)
    }

    func testOversizedAsset() throws {
        var limits = PrototypeSavedLayoutLimits()
        limits.maxImageBytes = 1
        let value = try loaded(limits)
        XCTAssertEqual(value.problems.map(\.kind), [.oversized, .oversized])
        XCTAssertEqual(Set(value.assets.keys), ["font-a"])
    }

    func testSymlinkAsset() throws {
        let image = try imageURL()
        try FileManager.default.removeItem(at: image)
        try FileManager.default.createSymbolicLink(
            at: image,
            withDestinationURL: directory.appendingPathComponent("spec.json")
        )
        try assertImageProblem(.unsafePath)
    }

    func testSymlinkFolder() throws {
        let folder = directory.appendingPathComponent("assets")
        try FileManager.default.removeItem(at: folder)
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: directory)
        try assertImageProblem(.unsafePath)
    }

    func testUndeclaredReference() throws {
        try mutateManifest { $0["assets"] = .array([]) }
        let value = try loaded()
        XCTAssertEqual(value.problems.map(\.assetId), ["image-a"])
        XCTAssertEqual(value.problems.map(\.kind), [.missing])
    }

    func testUnknownVersionPreservesEveryByte() throws {
        try writeManifest(.object(["formatVersion": .number(2), "future": .bool(true)]))
        let before = try snapshot()
        guard case .unsupportedFormat(version: 2) = PrototypeSavedLayoutReader().load(directory: directory)
        else { return XCTFail("Expected unsupported") }
        XCTAssertEqual(try snapshot(), before)
    }

    private func snapshot() throws -> [String: Data] {
        var result: [String: Data] = [:]
        for name in try FileManager.default.subpathsOfDirectory(atPath: directory.path) {
            let url = directory.appendingPathComponent(name)
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            if attributes[.type] as? FileAttributeType == .typeDirectory {
                result[name] = Data()
            } else {
                result[name] = try Data(contentsOf: url)
            }
        }
        return result
    }

    func testInvalidVersions() throws {
        for version: JSONValue in [.number(1.5), .string("1"), .bool(true), .null] {
            try writeManifest(.object(["formatVersion": version]))
            assertCorrupt()
        }
        try writeManifest(.object([:]))
        assertCorrupt()
    }

    func testInvalidManifestDocuments() throws {
        for text in ["garbage", "", "[]"] {
            try Data(text.utf8).write(to: directory.appendingPathComponent("manifest.json"))
            assertCorrupt()
        }
    }

    func testManifestCap() {
        var limits = PrototypeSavedLayoutLimits()
        limits.maxManifestBytes = 1
        assertCorrupt(limits)
    }

    func testUnknownKeys() throws {
        try mutateEntry { $0["extra"] = .bool(true) }
        assertCorrupt()
        try writeManifest(XCTUnwrap(fixture).expected.manifest)
        try mutateManifest { $0["extra"] = .bool(true) }
        assertCorrupt()
    }

    func testUnsafeManifestPaths() throws {
        for path in ["../spec.json", "fonts/hash.png", "assets/hash.jpg", "assets/hash.png"] {
            try mutateEntry { $0["file"] = .string(path) }
            assertCorrupt()
        }
    }

    func testDuplicateIds() throws {
        try mutateEntry("fonts") { $0["id"] = .string("image-a") }
        assertCorrupt()
    }

    func testWrongMediaTypeFolder() throws {
        try mutateEntry("fonts") { $0["mediaType"] = .string("image/png") }
        assertCorrupt()
    }

    func testBadSpec() throws {
        try Data("{}".utf8).write(to: directory.appendingPathComponent("spec.json"))
        assertCorrupt()
    }

    func testSpecCap() {
        var limits = PrototypeSavedLayoutLimits()
        limits.maxSpecBytes = 1
        assertCorrupt(limits)
    }

    func testMissingSpec() throws {
        try FileManager.default.removeItem(at: directory.appendingPathComponent("spec.json"))
        assertCorrupt()
    }

    func testMissingManifestInNonemptyDirectory() throws {
        try FileManager.default.removeItem(at: directory.appendingPathComponent("manifest.json"))
        assertCorrupt()
    }

    func testAbsentAndEmptyDirectory() throws {
        try FileManager.default.removeItem(at: directory)
        guard case .notFound = PrototypeSavedLayoutReader().load(directory: directory)
        else { return XCTFail("Expected notFound") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard case .notFound = PrototypeSavedLayoutReader().load(directory: directory)
        else { return XCTFail("Expected notFound") }
    }

    func testCountAndVerifiedTotalLimits() {
        var limits = PrototypeSavedLayoutLimits()
        limits.maxAssetCount = 2
        assertCorrupt(limits)
        limits.maxAssetCount = 3
        limits.maxTotalBytes = 1
        assertCorrupt(limits)
    }
}
