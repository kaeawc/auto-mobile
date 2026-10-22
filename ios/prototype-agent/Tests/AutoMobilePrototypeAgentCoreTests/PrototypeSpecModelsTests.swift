@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSpecModelsTests: XCTestCase {
    private struct Models: Decodable, Encodable {
        let offset: Offset
        let padding: Padding
    }

    func testFilledFixtureRoundTripsEveryField() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/models.json")
        let data = try Data(contentsOf: url)
        let models = try JSONDecoder().decode(Models.self, from: data)
        XCTAssertEqual(models.offset.x, -12.5)
        XCTAssertEqual(models.offset.y, 24.25)
        XCTAssertEqual(models.padding.top, 1.5)
        XCTAssertEqual(models.padding.bottom, 2.5)
        XCTAssertEqual(models.padding.start, 3.5)
        XCTAssertEqual(models.padding.end, 4.5)
        XCTAssertEqual(
            try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(models)),
            try JSONDecoder().decode(JSONValue.self, from: data)
        )
    }

    func testOptionalAndRequiredFieldsRetainDecodingBehavior() throws {
        for json in ["{}", #"{"top":null,"bottom":null,"start":null,"end":null}"#] {
            let padding = try JSONDecoder().decode(Padding.self, from: Data(json.utf8))
            XCTAssertNil(padding.top)
            XCTAssertNil(padding.bottom)
            XCTAssertNil(padding.start)
            XCTAssertNil(padding.end)
        }
        XCTAssertThrowsError(try JSONDecoder().decode(Offset.self, from: Data(#"{"x":1}"#.utf8)))
    }

    func testUnknownKeysStayIgnoredByLeafDecoderAndRejectedAtStrictBoundary() throws {
        let offset = #"{"x":1,"y":2,"unknown":1}"#
        let padding = #"{"top":1,"unknown":1}"#
        XCTAssertNoThrow(try JSONDecoder().decode(Offset.self, from: Data(offset.utf8)))
        XCTAssertNoThrow(try JSONDecoder().decode(Padding.self, from: Data(padding.utf8)))
        for (name, value) in [("offset", offset), ("padding", padding)] {
            let data = Data("""
            {"id":"models","window":{"placement":{"type":"fullscreen"}},
             "root":{"type":"box","children":[],"style":{"\(name)":\(value)}}}
            """.utf8)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data)) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: "root.style.\(name).unknown", message: "Unknown property")
                )
            }
        }
    }
}
