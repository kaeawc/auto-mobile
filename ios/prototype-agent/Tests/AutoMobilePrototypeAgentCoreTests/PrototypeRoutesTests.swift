@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRoutesTests: XCTestCase {
    func testActionDecoderPreservesRoutesAndIntegrationFields() throws {
        let raw = #"""
        [{"type":"setStack","stack":"nav","path":[{"screen":"detail","params":{"id":1}}]},
         {"type":"push","stack":"nav","screen":"detail","params":{"id":2}},
         {"type":"pop","stack":"nav","force":true},
         {"type":"scrollTo","scroll":"feed","to":{"key":"row"},"animated":false},
         {"type":"platform","call":"device.info","args":{"key":{"value":"id"}}},
         {"type":"request","url":"https://example.com","append":{"from":"/items","to":"/data/items"}}]
        """#
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: Data(raw.utf8))
        XCTAssertEqual(actions[0].stackPath?.first?.screen, "detail")
        XCTAssertEqual(actions[0].stackPath?.first?.params?["id"], .number(1))
        XCTAssertEqual(actions[1].params?["id"], .number(2))
        XCTAssertEqual(actions[2].force, true)
        XCTAssertEqual(actions[3].scroll, "feed")
        XCTAssertEqual(actions[3].to, .object(["key": .string("row")]))
        XCTAssertEqual(actions[3].animated, false)
        XCTAssertEqual(actions[4].call, "device.info")
        XCTAssertEqual(actions[4].args?["key"], .object(["value": .string("id")]))
        XCTAssertEqual(actions[5].append?.from, "/items")
        XCTAssertEqual(actions[5].append?.to, "/data/items")
    }

    private struct Invalid: Decodable {
        let spec: JSONValue
        let expectedPath: String
        let expectedMessage: String?
        let options: Options?
    }

    private struct Options: Decodable {
        let supportedCapabilities: Set<String>?
    }

    // Load fixture bytes before the timed tests, as the shared corpus runners do.
    private static let invalid: [(String, Invalid)] = {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("test/fixtures/prototype-spec/invalid")
        let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.lastPathComponent.hasPrefix("routes-") }.sorted { $0.path < $1.path }
            .compactMap { url in
                (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Invalid.self, from: $0) }
                    .map { (url.lastPathComponent, $0) }
            }
    }()

    override class func setUp() {
        super.setUp()
        _ = invalid
    }

    func testRouteDiagnosticParity() throws {
        XCTAssertGreaterThan(Self.invalid.count, 20, "route invalid fixtures must load")
        for (name, fixture) in Self.invalid {
            guard let message = fixture.expectedMessage else { continue }
            let data = try JSONEncoder().encode(fixture.spec)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
                data: data,
                supportedCapabilities: fixture.options?.supportedCapabilities
            )) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: fixture.expectedPath, message: message),
                    name
                )
            }
        }
    }
}
