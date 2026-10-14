@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeChecksTests: XCTestCase {
    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func fixture(_ path: String) throws -> Data {
        try Data(contentsOf: fixtureRoot.appendingPathComponent(path))
    }

    func testEverySharedPatternCase() throws {
        struct Entry: Decodable {
            let pattern: String
            let value: String
            let matches: Bool
        }
        let entries = try JSONDecoder().decode([Entry].self, from: fixture("checks/pattern-parity.json"))
        for entry in entries {
            XCTAssertEqual(
                PrototypeCheckPattern.matches(entry.pattern, entry.value),
                entry.matches,
                "\(entry.pattern): \(entry.value.debugDescription)"
            )
        }
    }

    func testEverySharedFormatCase() throws {
        struct Entry: Decodable {
            let format: String
            let value: String
            let matches: Bool
        }
        let entries = try JSONDecoder().decode([Entry].self, from: fixture("checks/format-parity.json"))
        for entry in entries {
            XCTAssertEqual(
                PrototypeChecks.formatPasses(entry.value, format: entry.format),
                entry.matches,
                "\(entry.format): \(entry.value.debugDescription)"
            )
        }
    }

    func testICUOnlyClassSyntaxAndAuthoredAnchorsStayPortable() {
        XCTAssertTrue(PrototypeCheckPattern.matches("[[]", "["))
        XCTAssertTrue(PrototypeCheckPattern.matches("[a&&b]", "&"))
        XCTAssertFalse(PrototypeCheckPattern.matches(#"a$[\s\S]"#, "a\n"))
        XCTAssertFalse(PrototypeCheckPattern.matches(#"a$[\s\S]"#, "a\u{0085}"))
        XCTAssertTrue(PrototypeCheckPattern.matches(".", "\u{0085}"))
    }

    func testUTF16CapPreservesSplitSurrogates() {
        let value = String(repeating: "a", count: 4095) + "😀"
        XCTAssertTrue(PrototypeCheckPattern.matches("a*.", value))
        XCTAssertFalse(PrototypeCheckPattern.matches("a*�", value))
    }

    func testEverySharedEvaluation() throws {
        struct Entry: Decodable {
            let nodeType: String
            let value: JSONValue?
            let checks: [PrototypeCheck]
            let expected: PrototypeCheckEvaluation
        }
        let entries = try JSONDecoder().decode([Entry].self, from: fixture("checks/evaluate.json"))
        for (index, entry) in entries.enumerated() {
            XCTAssertEqual(
                PrototypeChecks.evaluate(entry.value, checks: entry.checks, nodeType: entry.nodeType),
                entry.expected,
                "Case \(index)"
            )
        }
    }

    func testSharedValidSpecsDecode() throws {
        let files = try FileManager.default.contentsOfDirectory(
            at: fixtureRoot.appendingPathComponent("valid"), includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.hasPrefix("checks-") }
        XCTAssertFalse(files.isEmpty)
        for file in files {
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: file))
        }
    }

    func testSharedInvalidLimitAndTypedDecodingCases() throws {
        // The agent has no host-validator twin. Compatibility, grammar and cross-reference
        // failures belong to the host; resource-limit and typed-field failures must fail here.
        for name in ["too-many", "no-message", "fractional-length", "validate-on"] {
            let wrapper = try JSONDecoder().decode(
                [String: JSONValue].self,
                from: fixture("invalid/checks-\(name).json")
            )
            let spec = try XCTUnwrap(wrapper["spec"])
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(spec)), name)
        }
    }

    func testLimitBackstopsAndOpaquePayloads() throws {
        let source = try JSONDecoder().decode(JSONValue.self, from: fixture("valid/checks-form.json"))
        guard case var .object(spec) = source else { return XCTFail("Missing spec") }
        func decode(_ root: JSONValue) throws {
            spec["root"] = root
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(JSONValue.object(spec)))
        }
        for pattern in [String(repeating: "a", count: 129), "a{101}", "a{0,101}"] {
            XCTAssertThrowsError(try decode(.object([
                "type": .string("textField"), "stateKey": .string("textField"),
                "checks": .array([.object(["pattern": .string(pattern), "message": .string("Pattern")])]),
            ])))
        }
        let keys = JSONValue.array(Array(repeating: .string("textField"), count: 9))
        XCTAssertThrowsError(try decode(.object([
            "type": .string("button"), "enabledWhen": .object(["all": .array([.object(["valid": keys])])]),
        ])))
        XCTAssertThrowsError(try decode(.object([
            "type": .string("button"), "onTap": .array([.object([
                "type": .string("emit"), "requireValid": keys,
            ])]),
        ])))
        // An emit payload is opaque, even when it uses feature vocabulary.
        try decode(.object([
            "type": .string("button"), "onTap": .array([.object([
                "type": .string("emit"), "payload": .object(["valid": keys, "requireValid": keys]),
            ])]),
        ]))
        XCTAssertTrue(PrototypeCheckPattern.withinLimits("a{100}"))
        XCTAssertTrue(PrototypeCheckPattern.withinLimits(#"\{101\}"#))
    }

    func testRepeatBindsCheckMessagesConditionsAndGuardKeys() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"repeat","window":{"placement":{"type":"fullscreen"}},"state":{"field_1":""},
         "root":{"type":"column","repeat":{"items":[{"id":1,"message":"Needed"}],"as":"item"},
         "children":[{"type":"textField","stateKey":"field_{item.id}",
          "checks":[{"required":true,"message":"{item.message}"}]},
         {"type":"button","testTag":"submit","enabledWhen":{"not":{"valid":["field_{item.id}"]}},
          "onTap":[{"type":"emit","name":"submit","requireValid":["field_{item.id}"]}]}]}}
        """.utf8))
        let input = try XCTUnwrap(spec.root.children?.first)
        let button = try XCTUnwrap(spec.root.children?.last)
        XCTAssertEqual(input.checks?.first?.message, "Needed")
        XCTAssertEqual(button.onTap?.first?.requireValid, ["field_1"])
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertTrue(session.isEnabled(button))
        let events = try session.simulateTap(identifier: "submit").get()
        XCTAssertEqual(events.first?.keys, ["field_1"])
        XCTAssertEqual(session.shownError(input), "Needed")
    }

    private func form(_ mode: String = "submit") throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"checks","window":{"placement":{"type":"fullscreen"}},
         "state":{"email":"","count":0,"hour":0,"minute":0},
         "root":{"type":"column","children":[
          {"type":"textField","testTag":"email","stateKey":"email","validateOn":"\(mode)",
           "checks":[{"required":true,"message":"Required"},{"format":"email","message":"Email"}]},
          {"type":"button","testTag":"enabled","enabledWhen":{"valid":"email"},
           "onTap":[{"type":"increment","key":"count"}]},
          {"type":"button","testTag":"submit","onTap":[
           {"type":"increment","key":"count"},{"type":"emit","name":"before"},
           {"type":"emit","name":"submit","requireValid":["email"]},{"type":"dismiss"}]},
          {"type":"timePicker","hourKey":"hour","minuteKey":"minute","checks":[{"min":1,"message":"Positive"}]}
         ]}}
        """.utf8))
    }

    func testDisabledSessionTapSkipsActionsAndConditionsDeriveLiveValidity() throws {
        let spec = try form()
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertEqual(try session.simulateTap(identifier: "enabled").get(), [])
        XCTAssertEqual(session.state["count"], .number(0))
        _ = session.change(key: "email", value: .string("a@b.co"))
        XCTAssertTrue(try XCTUnwrap(spec.root.children?[1].enabledWhen).holds(session.state))
        _ = try session.simulateTap(identifier: "enabled").get()
        XCTAssertEqual(session.state["count"], .number(1))
    }

    func testRequireValidAbortsWholeListAndShowsErrors() throws {
        let spec = try form()
        let input = try XCTUnwrap(spec.root.children?.first)
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertNil(session.shownError(input))
        let events = try session.simulateTap(identifier: "submit").get()
        XCTAssertEqual(events.count, 1)
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.kind, "validation_failed")
        XCTAssertEqual(event.name, "submit")
        XCTAssertEqual(event.keys, ["email"])
        XCTAssertEqual(event.wireObject(timestamp: 0)["keys"] as? [String], ["email"])
        XCTAssertEqual(session.state["count"], .number(0))
        XCTAssertTrue(session.isShown)
        XCTAssertEqual(session.shownError(input), "Required")
        _ = session.change(key: "email", value: .string("bad"))
        XCTAssertEqual(session.shownError(input), "Email")
        _ = session.change(key: "email", value: .string("a@b.co"))
        XCTAssertNil(session.shownError(input))
        session.show(spec)
        XCTAssertTrue(session.shownErrors.isEmpty)
    }

    func testChangeEventsCarryFullValidityAtTopLevel() throws {
        var session = PrototypeSession()
        try session.show(form())
        let event = try XCTUnwrap(session.change(key: "email", value: .string("a@b.co")).first)
        XCTAssertEqual(event.validity, ["email": true, "hour": false, "minute": false])
        XCTAssertEqual(event.wireObject(timestamp: 0)["validity"] as? [String: Bool], event.validity)
        XCTAssertEqual(event.payload, .object(["key": .string("email"), "value": .string("a@b.co")]))
    }

    func testValidationModesAndFirstError() throws {
        for mode in ["change", "blur", "submit"] {
            let spec = try form(mode)
            let input = try XCTUnwrap(spec.root.children?.first)
            var session = PrototypeSession()
            session.show(spec)
            _ = session.change(key: "email", value: .string("bad"))
            XCTAssertEqual(session.shownError(input), mode == "change" ? "Email" : nil)
            session.blur(input)
            XCTAssertEqual(session.shownError(input), mode == "submit" ? nil : "Email")
        }
    }

    func testGuardsUseStateBeforeOwnWritesAndIgnoreActionsAfterDismiss() throws {
        let spec = try form()
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: Data("""
        [{"type":"emit","name":"save","requireValid":["email"]}]
        """.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let events = session.control(own: [("email", .string("a@b.co"))], then: actions)
        XCTAssertEqual(events.map(\.kind), ["validation_failed"])
        XCTAssertEqual(session.state["email"], .string(""))
        let afterDismiss = try JSONDecoder().decode([PrototypeAction].self, from: Data("""
        [{"type":"dismiss"},{"type":"emit","requireValid":["email"]}]
        """.utf8))
        XCTAssertEqual(session.run(afterDismiss).map(\.kind), ["dismissed"])
    }
}
