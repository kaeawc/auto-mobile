@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeLinkResolverTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Entry: Decodable { let path: String }
        struct Registration: Decodable {
            struct Web: Decodable { let scheme: String; let host: String }
            let schemes: [String]
            let web: [Web]
        }

        struct Case: Decodable {
            let url: String
            let registration: Registration
            let expected: PrototypeLinkMatcher.Match?
        }

        let table: [Entry]
        let cases: [Case]
    }

    func testSharedVectors() throws {
        let file = PrototypeSpecFixtures.directory.appendingPathComponent("links/resolver-vectors.json")
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
        for vector in vectors.cases {
            let registration = PrototypeLinkResolver.Registration(
                schemes: vector.registration.schemes,
                web: vector.registration.web.map { .init(scheme: $0.scheme, host: $0.host) }
            )
            XCTAssertEqual(PrototypeLinkResolver.resolve(
                vector.url,
                registration: registration,
                entries: vectors.table.map { .init(path: $0.path) }
            ), vector.expected, vector.url)
        }
    }
}
