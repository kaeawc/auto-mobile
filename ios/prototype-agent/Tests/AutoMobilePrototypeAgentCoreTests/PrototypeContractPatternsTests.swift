@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeContractPatternsTests: XCTestCase {
    private struct Cases: Decodable {
        let accepted: [String]
        let rejected: [String]
    }

    private func fixtures() throws -> [String: Cases] {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
        return try JSONDecoder().decode(
            [String: Cases].self, from: Data(contentsOf: directory.appendingPathComponent("patterns.json"))
        )
    }

    func testCorpusCoversEveryPattern() throws {
        let contract = try JSONDecoder().decode(JSONValue.self, from: Data(prototypeSpecContractData.utf8))
        XCTAssertEqual(
            try Set(fixtures().keys),
            try Set(XCTUnwrap(contract.objectFields?["patterns"]?.objectFields).keys)
        )
    }

    func testPathKeyPattern() throws { try assertPattern("pathKey") }
    func testStateKeyPattern() throws { try assertPattern("stateKey") }
    func testBoundKeyPattern() throws { try assertPattern("boundKey") }
    func testColorPattern() throws { try assertPattern("color") }
    func testBlankTextPattern() throws { try assertPattern("blankText") }
    func testNumberTokenPattern() throws { try assertPattern("numberToken") }
    func testPointerPattern() throws { try assertPattern("pointer") }

    private func assertPattern(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let cases = try XCTUnwrap(fixtures()[name], file: file, line: line)
        for (accepted, values) in [(true, cases.accepted), (false, cases.rejected)] {
            for text in values {
                XCTAssertEqual(
                    PrototypeContractValidator.matches(name, text), accepted,
                    "\(name): \(text.debugDescription)", file: file, line: line
                )
                if name == "stateKey" {
                    XCTAssertEqual(
                        PrototypeRepeat.isFieldName(text),
                        accepted,
                        text.debugDescription,
                        file: file,
                        line: line
                    )
                }
                if name == "boundKey" {
                    XCTAssertEqual(PrototypeContractValidator.primitive(
                        .string(text), rule: ["kind": .string("boundKey")]
                    ), accepted, text.debugDescription, file: file, line: line)
                }
                if name == "pointer" {
                    XCTAssertEqual(
                        PrototypeDataPointer.isValid(text),
                        accepted,
                        text.debugDescription,
                        file: file,
                        line: line
                    )
                }
            }
        }
    }
}
