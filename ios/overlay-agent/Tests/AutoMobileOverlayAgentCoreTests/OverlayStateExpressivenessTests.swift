@testable import AutoMobileOverlayAgentCore
import XCTest

/// `styleWhen` and `repeat` on iOS, checked against the shared validator fixtures that the
/// TypeScript and Kotlin validators accept (test/fixtures/overlay-spec/valid), so the three
/// implementations read the same specs the same way.
final class OverlayStateExpressivenessTests: XCTestCase {
    private func sharedFixture(_ name: String) throws -> OverlaySpec {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // AutoMobileOverlayAgentCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // overlay-agent
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("test/fixtures/overlay-spec/valid/\(name).json")
        return try JSONDecoder().decode(OverlaySpec.self, from: Data(contentsOf: url))
    }

    private func node(_ json: String) throws -> OverlayNode {
        try JSONDecoder().decode(OverlayNode.self, from: Data(json.utf8))
    }

    // MARK: styleWhen

    func testMatchingStyleWhenEntriesMergeOverTheBaseStyleInOrder() throws {
        let spec = try sharedFixture("style-when")
        let matched = try XCTUnwrap(spec.root.resolvedStyle(state: ["selected": .bool(true), "count": .number(3)]))
        XCTAssertEqual(matched.background, "#2255CC")
        XCTAssertEqual(matched.cornerRadius, 8)
        XCTAssertEqual(matched.alpha, 0.5)
        XCTAssertEqual(matched.border?.width, 1)
        XCTAssertEqual(matched.padding?.top, 4, "properties no entry sets keep the base value")

        let unmatched = try XCTUnwrap(spec.root.resolvedStyle(state: ["selected": .bool(false), "count": .number(11)]))
        XCTAssertEqual(unmatched.background, "#112233")
        XCTAssertNil(unmatched.cornerRadius)
        XCTAssertNil(unmatched.alpha)

        let text = try XCTUnwrap(spec.root.children?.first)
        let error = try XCTUnwrap(text.resolvedStyle(state: ["count": .number(0)]))
        XCTAssertEqual(error.color, "#FF0000")
        XCTAssertEqual(error.fontWeight, 700)
        XCTAssertEqual(error.textSize, 14)
    }

    func testALaterMatchingEntryWinsAndANodeWithoutAStyleTakesTheEntry() throws {
        let tinted = try node("""
        {"type":"text","text":"x","styleWhen":[
          {"when":{"key":"a","equals":true},"style":{"color":"#111111","textSize":12}},
          {"when":{"key":"b","equals":true},"style":{"color":"#222222"}}]}
        """)
        XCTAssertNil(tinted.resolvedStyle(state: [:]))
        let both = try XCTUnwrap(tinted.resolvedStyle(state: ["a": .bool(true), "b": .bool(true)]))
        XCTAssertEqual(both.color, "#222222")
        XCTAssertEqual(both.textSize, 12)
    }

    // MARK: repeat

    func testRepeatInstantiatesTheTemplateOncePerItemWithBoundValues() throws {
        let spec = try sharedFixture("repeat")
        let list = try XCTUnwrap(spec.root.children?[1])
        let rows = try XCTUnwrap(list.children)
        XCTAssertEqual(rows.map(\.type), ["row", "row"])
        XCTAssertEqual(list.style?.spacing, 4)

        let label = try XCTUnwrap(rows[1].children?[0])
        // `{other.label}` names no repeat alias, so it is left for state interpolation.
        XCTAssertEqual(label.text, "1: Beta costs 4.5 ({other.label}) false")
        XCTAssertEqual(label.visibleWhen, .notEquals(key: "selected", value: .string("b")))
        XCTAssertEqual(
            label.styleWhen?.first?.when,
            .all([.equals(key: "selected", value: .string("b")), .not(.greaterThan(key: "count", value: 0))])
        )
        XCTAssertEqual(rows[0].children?[0].text, "0: Alpha costs 3 ({other.label}) true")

        let actions = try XCTUnwrap(rows[1].children?[1].onTap)
        XCTAssertEqual(actions.map(\.value), [.string("b"), .number(1), nil])
        XCTAssertEqual(actions[2].name, "pick_b")
        XCTAssertEqual(actions[2].payload, .object(["id": .string("{item.id}")]), "emit payloads are not bound")
    }

    func testRepeatedRowsDriveStateThroughTheSession() throws {
        let spec = try sharedFixture("repeat")
        var session = OverlaySession()
        session.show(spec)
        let second = try XCTUnwrap(spec.root.children?[1].children?[1].children?[1].onTap)
        let events = session.run(second)
        XCTAssertEqual(events.map(\.name), ["pick_b", "change"])
        XCTAssertEqual(session.state["selected"], .string("b"))
        XCTAssertEqual(session.state["last"], .number(1))

        let decrement = try XCTUnwrap(spec.root.children?[2].onTap)
        _ = session.run(decrement)
        XCTAssertEqual(session.state["count"], .number(0))
    }

    func testAPlaceholderThatIsTheWholeOperandKeepsTheItemType() throws {
        let expanded = OverlayRepeat.expand(.object([
            "type": .string("column"),
            "repeat": .object([
                "as": .string("row"),
                "items": .array([.object(["n": .number(7), "big": .number(1e20)])]),
            ]),
            "children": .array([.object([
                "type": .string("text"),
                "text": .string("{row.big}/{row.n}/{count}/{index}"),
                "visibleWhen": .object(["key": .string("n"), "equals": .string("{row.n}")]),
            ])]),
        ]))
        XCTAssertEqual(expanded, .object([
            "type": .string("column"),
            "children": .array([.object([
                "type": .string("text"),
                "text": .string("100000000000000000000/7/{count}/0"),
                "visibleWhen": .object(["key": .string("n"), "equals": .number(7)]),
            ])]),
        ]))
    }

    func testPlaceholderSegmentsLeaveOtherBracesLiteral() {
        XCTAssertEqual(
            OverlayRepeat.segments("{index}{it.a_1}{it.}{it.1x}{x}}{", alias: "it"),
            [.index, .field("a_1"), .literal("{it.}{it.1x}{x}}{")]
        )
    }
}
