@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeRequestUploadTests: XCTestCase {
    private static let valid = load("valid")
    private static let invalid = load("invalid")

    override class func setUp() {
        super.setUp()
        _ = valid
        _ = invalid
    }

    private static func load(_ kind: String) -> [String: Data] {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent(kind)
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return Dictionary(
            uniqueKeysWithValues: urls.filter { $0.lastPathComponent.hasPrefix("request-upload") }
                .compactMap { url in
                    guard let data = try? Data(contentsOf: url) else { return nil }
                    return (url.lastPathComponent, data)
                }
        )
    }

    private func accepts(_ name: String) throws {
        let data = try XCTUnwrap(Self.valid["request-upload\(name).json"])
        XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data))
    }

    private func rejects(_ name: String) throws {
        let data = try XCTUnwrap(Self.invalid["request-upload-\(name).json"])
        let fixture = try JSONDecoder().decode(PrototypeSpecFixtures.Invalid.self, from: data)
        XCTAssertThrowsError(try fixture.decode())
    }

    func testMultipart() throws { try accepts("") }
    func testForm() throws { try accepts("-form") }
    func testFile() throws { try accepts("-file") }
    func testProgress() throws {
        try accepts("-progress")
        let data = try XCTUnwrap(Self.valid["request-upload-progress.json"])
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        XCTAssertEqual(spec.root.onTap?.first?.progressKey, "progress")
    }

    func testSixteenParts() throws { try accepts("-16-parts") }
    func testFilePath() throws { try rejects("path") }
    func testGet() throws { try rejects("get") }
    func testHead() throws { try rejects("head") }
    func testSeventeenParts() throws { try rejects("17-parts") }
    func testUnknownPart() throws { try rejects("unknown-part") }
    func testBothSources() throws { try rejects("both") }
    func testMedia() throws { try rejects("media") }
    func testStringProgress() throws { try rejects("progress-string") }
    func testUndeclaredProgress() throws { try rejects("progress-undeclared") }
    func testProgressOver() throws { try rejects("progress-over") }
    func testProgressUnder() throws { try rejects("progress-under") }
}
