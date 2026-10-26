@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStringConditionsTests: XCTestCase {
    private struct Fixture: Decodable {
        let name: String
        let condition: Condition
        let state: [String: JSONValue]
        let expected: Bool
    }

    func testSharedUTF16Conditions() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/conditions/string-conditions.json")
        for fixture in try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url)) {
            XCTAssertEqual(fixture.condition.holds(fixture.state), fixture.expected, fixture.name)
        }
        XCTAssertTrue(Condition.contains(key: "value", value: .string("")).holds(["value": .string("")]))
        XCTAssertTrue(Condition.startsWith(key: "value", value: .string("")).holds(["value": .string("hello")]))
    }

    func testForcedErrorDecisionDoesNotRequireChecks() {
        for (errorText, checkMessage, supportingText, expected) in [
            ("Server", "Check", "Help", "Server"),
            (nil, "Check", "Help", "Check"),
            (nil, nil, "Help", "Help"),
            (nil, nil, nil, nil),
        ] as [(String?, String?, String?, String?)] {
            let result = PrototypeFieldError.resolve(
                forced: true,
                errorText: errorText,
                checkMessage: checkMessage,
                supportingText: supportingText
            )
            XCTAssertTrue(result.isError)
            XCTAssertEqual(result.message, expected)
        }
        XCTAssertEqual(PrototypeFieldError.resolve(
            forced: false,
            errorText: "Server",
            checkMessage: nil,
            supportingText: "Help"
        ), .init(isError: false, message: nil))
        XCTAssertEqual(PrototypeFieldError.resolve(
            forced: false,
            errorText: "Server",
            checkMessage: "Check",
            supportingText: "Help"
        ), .init(isError: true, message: "Check"))
    }

    func testRepeatErrorConditionsAndBundleRequirements() throws {
        let data =
            Data(
                #"{"id":"errors","window":{"placement":{"type":"fullscreen"}},"state":{"value":"hello"},"root":{"type":"column","repeat":{"as":"item","items":[{"x":""}]},"children":[{"type":"textField","stateKey":"value","errorWhen":{"key":"value","contains":"{item.x}"},"errorText":"Bad {index}"}]}}"#
                    .utf8
            )
        XCTAssertEqual(try PrototypeBundleCapabilities.required(data), ["prototype_string_conditions_v1"])
        let raw = try JSONDecoder().decode(JSONValue.self, from: data)
        let root = try XCTUnwrap(raw.objectFields?["root"])
        let expanded = PrototypeRepeat.expand(root)
        let decoded = try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(expanded))
        let field = try XCTUnwrap(decoded.children?.first)
        XCTAssertEqual(field.errorText, "Bad 0")
        XCTAssertTrue(field.errorWhen?.holds(["value": .string("hello")]) == true)
        XCTAssertEqual(
            PrototypeFieldError.shown(field, state: ["value": .string("hello")], shown: []),
            .init(isError: true, message: "Bad 0")
        )
        XCTAssertFalse(Condition.contains(key: "value", value: .number(1)).holds(["value": .string("1")]))
    }

    func testForcedErrorsDoNotCreateValidityOrBlurBookkeeping() throws {
        let data =
            Data(
                #"{"id":"error","window":{"placement":{"type":"fullscreen"}},"state":{"value":"hello"},"root":{"type":"textField","stateKey":"value","errorWhen":{"key":"value","contains":"h"},"errorText":"Server"}}"#
                    .utf8
            )
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: data))
        let field = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(session.shownError(field), "Server")
        XCTAssertTrue(session.validity.isEmpty)
        session.blur(field)
        XCTAssertTrue(session.shownErrors.isEmpty)
        let event = try XCTUnwrap(session.change(key: "value", value: .string("hi")).first)
        XCTAssertNil(event.validity)
    }

    func testForcedErrorsLeaveCheckValidityUntouched() throws {
        let data =
            Data(
                #"{"id":"error","window":{"placement":{"type":"fullscreen"}},"state":{"value":"hello"},"root":{"type":"textField","stateKey":"value","checks":[{"message":"Required","required":true}],"errorWhen":{"key":"value","contains":"h"},"errorText":"Server"}}"#
                    .utf8
            )
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: data))
        let field = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(session.shownError(field), "Server")
        XCTAssertEqual(session.validity, ["value": true])
        let event = try XCTUnwrap(session.change(key: "value", value: .string("hi")).first)
        XCTAssertEqual(event.validity, ["value": true])
    }

    func testNumericRepeatPlaceholderBindsSubstringOperandAsText() throws {
        let data =
            Data(
                #"{"id":"n","window":{"placement":{"type":"fullscreen"}},"state":{"value":"a3"},"root":{"type":"column","repeat":{"as":"item","items":[{"n":3}]},"children":[{"type":"textField","stateKey":"value","errorWhen":{"key":"value","contains":"{item.n}"}}]}}"#
                    .utf8
            )
        let raw = try JSONDecoder().decode(JSONValue.self, from: data)
        let root = try XCTUnwrap(raw.objectFields?["root"])
        let decoded = try JSONDecoder().decode(
            PrototypeNode.self,
            from: JSONEncoder().encode(PrototypeRepeat.expand(root))
        )
        let field = try XCTUnwrap(decoded.children?.first)
        XCTAssertTrue(field.errorWhen?.holds(["value": .string("a3")]) == true)
        XCTAssertFalse(field.errorWhen?.holds(["value": .string("a4")]) == true)
    }
}
