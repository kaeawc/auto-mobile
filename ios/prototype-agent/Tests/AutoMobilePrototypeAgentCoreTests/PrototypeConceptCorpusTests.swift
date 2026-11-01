@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Reference concept slices (#14205), shared with the TypeScript and Kotlin suites.
final class PrototypeConceptCorpusTests: XCTestCase {
    private struct Manifest: Decodable {
        let capabilities: [String]
    }

    private var concepts: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-concepts")
    }

    private func conceptDirectories() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: concepts,
            includingPropertiesForKeys: [.isDirectoryKey]
        )
        .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testEveryConceptSliceLoadsOnThisAgentAndDerivesItsCapabilities() throws {
        let directories = try conceptDirectories()
        XCTAssertFalse(directories.isEmpty)
        for directory in directories {
            let name = directory.lastPathComponent
            let data = try Data(contentsOf: directory.appendingPathComponent("today.json"))
            let manifest = try JSONDecoder().decode(
                Manifest.self,
                from: Data(contentsOf: directory.appendingPathComponent("concept.json"))
            )
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), name)
            XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data), name)
            // A today slice uses only what this agent advertises, so it loads with the default set.
            XCTAssertNoThrow(try PrototypeEmbeddedSpec.load(data: data), name)
            let value = try JSONDecoder().decode(JSONValue.self, from: PrototypeStrictJSON.prepare(data))
            XCTAssertEqual(
                PrototypeStrictCapabilities.required(value.objectFields ?? [:]).sorted(),
                manifest.capabilities,
                name
            )
        }
    }
}
