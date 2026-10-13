@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRefusedEditTests: XCTestCase {
    private func shown(
        state: String = #"{"query":"ok"}"#,
        children: String = #"{"type":"textField","stateKey":"query"}"#
    ) throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(
            JSONDecoder().decode(PrototypeSpec.self, from: Data("""
            {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":\(state),
             "root":{"type":"column","children":[\(children)]}}
            """.utf8))
        )
        return session
    }

    func testDateValidatedTextSettlesAfterEachRefusedKeystroke() throws {
        var session = try shown(
            state: #"{"d":"2026-10-13"}"#,
            children: #"{"type":"textField","stateKey":"d"},{"type":"datePicker","stateKey":"d"}"#
        )
        var draft = PrototypeTextDraft(stored: try XCTUnwrap(session.state["d"]?.displayString))
        XCTAssertEqual(draft.text, "2026-10-13")
        for typed in ["2026-10-13X", "2026-10-139"] {
            let before = session
            draft.type(typed)
            XCTAssertEqual(draft.text, typed)
            XCTAssertTrue(draft.needsCommit(stored: try XCTUnwrap(session.state["d"]?.displayString)))
            XCTAssertTrue(session.change(key: "d", value: .string(draft.text)).isEmpty)
            XCTAssertEqual(session.state["d"], .string("2026-10-13"))
            XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
            XCTAssertTrue(draft.settle(stored: try XCTUnwrap(session.state["d"]?.displayString)))
            XCTAssertEqual(draft.text, "2026-10-13")
            XCTAssertFalse(draft.needsCommit(stored: "2026-10-13"))
        }
    }

    func testAcceptedTextNeedsNoRewriteOrSecondCommit() throws {
        var session = try shown()
        let before = session
        var draft = PrototypeTextDraft(stored: try XCTUnwrap(session.state["query"]?.displayString))
        draft.type("typed")
        XCTAssertTrue(draft.needsCommit(stored: "ok"))
        let events = session.change(key: "query", value: .string(draft.text))
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertEqual(session.state["query"], .string("typed"))
        XCTAssertFalse(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        let stored = try XCTUnwrap(session.state["query"]?.displayString)
        XCTAssertFalse(draft.settle(stored: stored))
        XCTAssertEqual(draft.text, "typed")
        XCTAssertFalse(draft.needsCommit(stored: stored))
    }

    func testOversizeTextSettlesToLastAcceptedEdit() throws {
        var session = try shown()
        var draft = PrototypeTextDraft(stored: try XCTUnwrap(session.state["query"]?.displayString))
        draft.type("accepted")
        XCTAssertEqual(session.change(key: "query", value: .string(draft.text)).count, 1)
        XCTAssertFalse(draft.settle(stored: try XCTUnwrap(session.state["query"]?.displayString)))
        let before = session
        draft.type(String(repeating: "x", count: PrototypeLimits.maxSpecBytes + 1))
        XCTAssertTrue(draft.needsCommit(stored: "accepted"))
        XCTAssertTrue(session.change(key: "query", value: .string(draft.text)).isEmpty)
        XCTAssertEqual(session.state["query"], .string("accepted"))
        XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        XCTAssertTrue(draft.settle(stored: try XCTUnwrap(session.state["query"]?.displayString)))
        XCTAssertEqual(draft.text, "accepted")
        XCTAssertFalse(draft.needsCommit(stored: "accepted"))
    }

    func testExternalStateChangeRewritesIdleDraft() throws {
        var session = try shown()
        var draft = PrototypeTextDraft(stored: try XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertFalse(draft.needsCommit(stored: "ok"))
        XCTAssertEqual(session.setStates([("query", .string("external"))]).count, 1)
        XCTAssertTrue(draft.settle(stored: try XCTUnwrap(session.state["query"]?.displayString)))
        XCTAssertEqual(draft.text, "external")
        XCTAssertFalse(draft.needsCommit(stored: "external"))
    }

    func testSliderRedrawRuleForRefusalClampAndAcceptedEdit() throws {
        var session = try shown(
            state: #"{"v":0}"#,
            children: #"{"type":"slider","stateKey":"v","min":0,"max":10}"#
        )
        for value in [11.0, snapPrototypeSlider(-1, min: 0, max: 10, step: nil)] {
            let before = session
            XCTAssertTrue(session.slide(key: "v", value: value, then: []).isEmpty)
            XCTAssertEqual(session.state["v"], .number(0))
            XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        }
        let before = session
        XCTAssertEqual(session.slide(key: "v", value: 5, then: []).count, 1)
        XCTAssertEqual(session.state["v"], .number(5))
        XCTAssertFalse(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
    }

    func testTimeRedrawRuleForUnchangedAndAcceptedEdit() throws {
        var session = try shown(
            state: #"{"h":7,"m":30}"#,
            children: #"{"type":"timePicker","hourKey":"h","minuteKey":"m"}"#
        )
        let before = session
        XCTAssertTrue(session.setTime(hourKey: "h", minuteKey: "m", hour: 7, minute: 30, then: []).isEmpty)
        XCTAssertEqual(session.state["h"], .number(7))
        XCTAssertEqual(session.state["m"], .number(30))
        XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        XCTAssertEqual(session.setTime(hourKey: "h", minuteKey: "m", hour: 8, minute: 30, then: []).count, 1)
        XCTAssertEqual(session.state["h"], .number(8))
        XCTAssertEqual(session.state["m"], .number(30))
        XCTAssertFalse(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
    }

    func testDateRedrawRuleForRefusedAndAcceptedChoice() throws {
        var session = try shown(
            state: #"{"d":"2026-10-13"}"#,
            children: #"{"type":"datePicker","stateKey":"d"}"#
        )
        let before = session
        XCTAssertTrue(session.choose(key: "d", value: "2026-02-30", then: []).isEmpty)
        XCTAssertEqual(session.state["d"], .string("2026-10-13"))
        XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        XCTAssertEqual(session.choose(key: "d", value: "2026-10-14", then: []).count, 1)
        XCTAssertEqual(session.state["d"], .string("2026-10-14"))
        XCTAssertFalse(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
    }

    func testPagerRedrawRuleForCurrentClampedAndAcceptedPage() throws {
        var session = try shown(
            children: #"{"type":"pager","id":"pager","children":[{"type":"spacer"},{"type":"spacer"}]}"#
        )
        for target in [0, -1] {
            let before = session
            XCTAssertTrue(session.setPage("pager", target).isEmpty)
            XCTAssertEqual(session.pages["pager"], 0)
            XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        }
        let before = session
        XCTAssertEqual(session.setPage("pager", 1).count, 1)
        XCTAssertEqual(session.pages["pager"], 1)
        XCTAssertFalse(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        let atLastPage = session
        XCTAssertTrue(session.setPage("pager", 99).isEmpty)
        XCTAssertEqual(session.pages["pager"], 1)
        XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: atLastPage, after: session))
    }
}
