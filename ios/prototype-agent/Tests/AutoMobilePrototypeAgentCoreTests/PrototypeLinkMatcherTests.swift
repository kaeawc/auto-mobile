@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeLinkMatcherTests: XCTestCase {
    private struct VectorEntry: Decodable {
        let path: String
        let query: [String: String]?
        let usedCaptures: Set<String>?

        var entry: PrototypeLinkMatcher.Entry {
            .init(path: path, query: query ?? [:], usedCaptures: usedCaptures)
        }
    }

    private struct Vectors: Decodable {
        struct MatchCase: Decodable {
            let url: String
            let expected: PrototypeLinkMatcher.Match?
        }

        struct Group: Decodable {
            let name: String
            let table: [VectorEntry]
            let cases: [MatchCase]
        }

        struct ValidationExpected: Decodable, Equatable {
            let index: Int
            let code: String
        }

        struct Validation: Decodable {
            let name: String
            let table: [VectorEntry]
            let expected: [ValidationExpected]
        }

        let matchGroups: [Group]
        let validationCases: [Validation]
    }

    private func vectors() throws -> Vectors {
        let file = PrototypeSpecFixtures.directory.appendingPathComponent("links/matcher-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
    }

    func testSharedMatchingVectors() throws {
        for group in try vectors().matchGroups {
            let entries = group.table.map(\.entry)
            for vector in group.cases {
                // JSONValue represents both int and number as Double, preserving numeric equality.
                XCTAssertEqual(
                    PrototypeLinkMatcher.match(vector.url, entries: entries), vector.expected,
                    "\(group.name): \(vector.url)"
                )
            }
        }
    }

    func testSharedValidationVectors() throws {
        for vector in try vectors().validationCases {
            let errors = PrototypeLinkMatcher.validateLinkTable(vector.table.map(\.entry))
            XCTAssertEqual(
                errors.map { Vectors.ValidationExpected(index: $0.index, code: $0.code) },
                vector.expected,
                vector.name
            )
            XCTAssertTrue(errors.allSatisfy { !$0.message.isEmpty })
        }
    }
}
