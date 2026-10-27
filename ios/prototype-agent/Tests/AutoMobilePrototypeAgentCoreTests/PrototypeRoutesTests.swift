@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRoutesTests: XCTestCase {
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
        return (try! FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil))
            .filter { $0.lastPathComponent.hasPrefix("routes-") }.sorted { $0.path < $1.path }
            .map { ($0.lastPathComponent, try! JSONDecoder().decode(Invalid.self, from: Data(contentsOf: $0))) }
    }()

    override class func setUp() {
        super.setUp()
        _ = invalid
    }

    func testRouteDiagnosticParity() throws {
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
