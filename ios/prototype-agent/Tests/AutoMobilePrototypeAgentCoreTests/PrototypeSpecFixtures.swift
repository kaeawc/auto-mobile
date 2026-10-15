@testable import AutoMobilePrototypeAgentCore
import Foundation

/// Shared repository fixtures for the feature decoding suites.
enum PrototypeSpecFixtures {
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    struct Invalid: Decodable {
        let spec: JSONValue
        let expectedPath: String
        let expectedMessage: String?

        func decode() throws -> PrototypeSpec {
            try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(spec))
        }
    }

    static func invalid(_ name: String) throws -> Invalid {
        try JSONDecoder().decode(
            Invalid.self, from: Data(contentsOf: directory.appendingPathComponent("invalid/\(name).json"))
        )
    }
}
