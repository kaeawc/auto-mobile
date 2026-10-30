@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// BLE codecs (#14266) replay the fixture the TypeScript reference and Kotlin twin replay.
final class PrototypeBleCodecsTests: XCTestCase {
    private var fixture: [String: JSONValue] {
        get throws {
            let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("test/fixtures/prototype-spec/ble/codecs.json")
            return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).objectFields)
        }
    }

    private func bytes(_ hex: String) -> [UInt8] {
        let digits = Array(hex.utf8)
        return stride(from: 0, to: digits.count, by: 2).map {
            UInt8(String(decoding: digits[$0 ..< $0 + 2], as: UTF8.self), radix: 16) ?? 0
        }
    }

    func testCodecListAndLimitMatchTheSharedFixture() throws {
        let fixture = try fixture
        XCTAssertEqual(fixture["codecs"], .array(PrototypeBleCodecs.codecs.map(JSONValue.string)))
        XCTAssertEqual(fixture["maxBytes"], .number(Double(PrototypeBleCodecs.maxValueBytes)))
    }

    func testSharedCodecFixture() throws {
        guard case let .array(cases)? = try fixture["cases"] else { return XCTFail("Expected cases") }
        for raw in cases {
            let fields = try XCTUnwrap(raw.objectFields)
            let name = fields["name"]?.stringValue ?? "unnamed"
            let codec = try XCTUnwrap(fields["codec"]?.stringValue)
            let input = try XCTUnwrap(fields["input"])
            let actual: JSONValue = if fields["op"] == .string("decode") {
                switch PrototypeBleCodecs.decode(codec, bytes(input.stringValue ?? "")) {
                case let .success(value): value
                case let .failure(error): .string(error.rawValue)
                }
            } else {
                switch PrototypeBleCodecs.encode(codec, input) {
                case let .success(value): .string(value.map { String(format: "%02x", $0) }.joined())
                case let .failure(error): .string(error.rawValue)
                }
            }
            XCTAssertEqual(actual, fields["error"] ?? fields["expected"], name)
        }
    }
}
