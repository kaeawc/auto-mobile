@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRefusedEditTests: XCTestCase {
    private func shown(
        state: String = #"{"query":"ok"}"#,
        children: String = #"{"type":"textField","stateKey":"query"}"#,
        specBytes: Int? = nil
    )
        throws -> PrototypeSession
    {
        var session = PrototypeSession()
        try session.show(
            JSONDecoder().decode(PrototypeSpec.self, from: Data("""
            {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":\(state),
             "root":{"type":"column","children":[\(children)]}}
            """.utf8)),
            specBytes: specBytes
        )
        return session
    }

    private func keystroke(
        _ typed: String,
        draft: inout PrototypeTextDraft,
        session: inout PrototypeSession,
        key: String
    )
        throws -> [PrototypeEvent]
    {
        draft.type(typed)
        let stored = try XCTUnwrap(session.state[key]?.displayString)
        guard draft.needsCommit(stored: stored) else { return [] }
        return session.change(key: key, value: .string(draft.text))
    }

    func testDateValidatedTextKeepsRefusedKeystrokesUntilEditingEnds() throws {
        var session = try shown(
            state: #"{"d":"2026-10-13"}"#,
            children: #"{"type":"textField","stateKey":"d"},{"type":"datePicker","stateKey":"d"}"#
        )
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["d"]?.displayString))
        XCTAssertEqual(draft.text, "2026-10-13")
        for typed in ["2026-10-13X", "2026-10-13X9"] {
            let before = session
            XCTAssertTrue(try keystroke(typed, draft: &draft, session: &session, key: "d").isEmpty)
            XCTAssertEqual(draft.text, typed)
            XCTAssertTrue(try draft.needsCommit(stored: XCTUnwrap(session.state["d"]?.displayString)))
            XCTAssertEqual(session.state["d"], .string("2026-10-13"))
            XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        }
        let stored = try XCTUnwrap(session.state["d"]?.displayString)
        XCTAssertTrue(draft.endEditing(stored: stored))
        XCTAssertEqual(draft.text, "2026-10-13")
        // Submit followed by blur must restore only once (#12206).
        XCTAssertFalse(draft.endEditing(stored: stored))
        XCTAssertFalse(draft.needsCommit(stored: stored))
    }

    func testDateTypedThroughInvalidIntermediateCommitsBeforeEditingEnds() throws {
        var session = try shown(
            state: #"{"d":"2026-10-13"}"#,
            children: #"{"type":"textField","stateKey":"d"},{"type":"datePicker","stateKey":"d"}"#
        )
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["d"]?.displayString))
        var events = try keystroke("2026-10-1", draft: &draft, session: &session, key: "d")
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(draft.text, "2026-10-1")
        XCTAssertEqual(session.state["d"], .string("2026-10-13"))
        try events.append(contentsOf: keystroke("2026-10-14", draft: &draft, session: &session, key: "d"))
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertEqual(session.state["d"], .string("2026-10-14"))
        let stored = try XCTUnwrap(session.state["d"]?.displayString)
        XCTAssertFalse(draft.endEditing(stored: stored))
        XCTAssertEqual(draft.text, "2026-10-14")
    }

    func testInvalidFinalValueRestoredOnBlur() throws {
        var session = try shown(specBytes: PrototypeLimits.maxSpecBytes)
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertTrue(try keystroke("too long", draft: &draft, session: &session, key: "query").isEmpty)
        XCTAssertEqual(draft.text, "too long")
        let stored = try XCTUnwrap(session.state["query"]?.displayString)
        XCTAssertTrue(draft.endEditing(stored: stored))
        XCTAssertEqual(draft.text, "ok")
        XCTAssertFalse(draft.endEditing(stored: stored))
    }

    func testInvalidFinalValueRestoredOnSubmit() throws {
        var session = try shown(specBytes: PrototypeLimits.maxSpecBytes)
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertTrue(try keystroke("too long", draft: &draft, session: &session, key: "query").isEmpty)
        XCTAssertEqual(draft.text, "too long")
        let stored = try XCTUnwrap(session.state["query"]?.displayString)
        XCTAssertTrue(draft.endEditing(stored: stored))
        XCTAssertEqual(draft.text, "ok")
        XCTAssertFalse(draft.endEditing(stored: stored))
    }

    func testAcceptedTextNeedsNoRewriteOrSecondCommit() throws {
        var session = try shown()
        let before = session
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        let events = try keystroke("typed", draft: &draft, session: &session, key: "query")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertEqual(session.state["query"], .string("typed"))
        XCTAssertFalse(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        let stored = try XCTUnwrap(session.state["query"]?.displayString)
        XCTAssertFalse(draft.storedChanged(to: stored))
        XCTAssertFalse(draft.endEditing(stored: stored))
        XCTAssertEqual(draft.text, "typed")
        XCTAssertFalse(draft.needsCommit(stored: stored))
    }

    func testOversizeTextRestoresLastAcceptedEditWhenEditingEnds() throws {
        // Growing "ok" to "accepted" fills the cap; one more byte is refused without a huge string.
        var session = try shown(specBytes: PrototypeLimits.maxSpecBytes - 6)
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        var events = try keystroke("accepted", draft: &draft, session: &session, key: "query")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertEqual(session.state["query"], .string("accepted"))
        XCTAssertEqual(draft.text, "accepted")
        let before = session
        let refused = try keystroke("accepted!", draft: &draft, session: &session, key: "query")
        XCTAssertTrue(refused.isEmpty)
        events.append(contentsOf: refused)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(draft.text, "accepted!")
        XCTAssertTrue(draft.needsCommit(stored: "accepted"))
        XCTAssertEqual(session.state["query"], .string("accepted"))
        XCTAssertTrue(PrototypeRefusedChange.leftValuesUnchanged(before: before, after: session))
        XCTAssertTrue(try draft.endEditing(stored: XCTUnwrap(session.state["query"]?.displayString)))
        XCTAssertEqual(draft.text, "accepted")
        XCTAssertFalse(draft.needsCommit(stored: "accepted"))
    }

    func testExternalStateChangeRewritesFocusedRefusedDraft() throws {
        var session = try shown(
            state: #"{"d":"2026-10-13"}"#,
            children: #"{"type":"textField","stateKey":"d"},{"type":"datePicker","stateKey":"d"}"#
        )
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["d"]?.displayString))
        XCTAssertTrue(try keystroke("2026-10-13X", draft: &draft, session: &session, key: "d").isEmpty)
        XCTAssertEqual(draft.text, "2026-10-13X")
        XCTAssertEqual(session.setStates([("d", .string("2026-10-14"))]).count, 1)
        XCTAssertTrue(try draft.storedChanged(to: XCTUnwrap(session.state["d"]?.displayString)))
        XCTAssertEqual(draft.text, "2026-10-14")
        XCTAssertFalse(draft.needsCommit(stored: "2026-10-14"))
    }

    func testExternalStateChangeRewritesIdleDraft() throws {
        var session = try shown()
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertFalse(draft.needsCommit(stored: "ok"))
        XCTAssertEqual(session.setStates([("query", .string("external"))]).count, 1)
        XCTAssertTrue(try draft.storedChanged(to: XCTUnwrap(session.state["query"]?.displayString)))
        XCTAssertEqual(draft.text, "external")
        XCTAssertFalse(draft.needsCommit(stored: "external"))
    }

    func testTypingBackToStoredValueNeedsNoCommitOrRewrite() throws {
        var session = try shown(specBytes: PrototypeLimits.maxSpecBytes)
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertTrue(try keystroke("too long", draft: &draft, session: &session, key: "query").isEmpty)
        XCTAssertEqual(draft.text, "too long")
        let stored = try XCTUnwrap(session.state["query"]?.displayString)
        XCTAssertTrue(try keystroke(stored, draft: &draft, session: &session, key: "query").isEmpty)
        XCTAssertFalse(draft.needsCommit(stored: stored))
        XCTAssertFalse(draft.endEditing(stored: stored))
        XCTAssertEqual(draft.text, "ok")
        XCTAssertEqual(session.lastSequence, 0)
    }

    func testUnfocusedRefusedTextSettlesImmediatelyAfterEdit() throws {
        var session = try shown(specBytes: PrototypeLimits.maxSpecBytes)
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertTrue(try keystroke("too long", draft: &draft, session: &session, key: "query").isEmpty)
        XCTAssertTrue(try draft.endEditing(stored: XCTUnwrap(session.state["query"]?.displayString)))
        XCTAssertEqual(draft.text, "ok")
        XCTAssertFalse(draft.needsCommit(stored: "ok"))
    }

    func testReplacingShowEndsDraftEvenWhenStoredValueIsUnchanged() throws {
        var session = try shown(specBytes: PrototypeLimits.maxSpecBytes)
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["query"]?.displayString))
        XCTAssertTrue(try keystroke("too long", draft: &draft, session: &session, key: "query").isEmpty)
        let spec = try XCTUnwrap(session.spec)
        session.show(spec, specBytes: PrototypeLimits.maxSpecBytes)
        XCTAssertEqual(session.state["query"], .string("ok"))
        XCTAssertEqual(draft.text, "too long")
        XCTAssertTrue(try draft.endEditing(stored: XCTUnwrap(session.state["query"]?.displayString)))
        XCTAssertEqual(draft.text, "ok")
    }

    func testKeyChangeSettlesDraftToNewKeysStoredValue() throws {
        let session = try shown(
            state: #"{"a":"first","b":"second"}"#,
            children: #"{"type":"textField","stateKey":"a"},{"type":"textField","stateKey":"b"}"#
        )
        var draft = try PrototypeTextDraft(stored: XCTUnwrap(session.state["a"]?.displayString))
        XCTAssertEqual(draft.text, "first")
        let stored = try XCTUnwrap(session.state["b"]?.displayString)
        XCTAssertTrue(draft.storedChanged(to: stored))
        XCTAssertEqual(draft.text, "second")
        XCTAssertFalse(draft.needsCommit(stored: stored))
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
