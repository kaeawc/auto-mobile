@testable import AutoMobileOverlayAgentCore
import XCTest

final class OverlaySessionTests: XCTestCase {
    private func spec(_ json: String) throws -> OverlaySpec {
        try JSONDecoder().decode(OverlaySpec.self, from: Data(json.utf8))
    }

    private func textSpec(id: String, state: String = "{}") throws -> OverlaySpec {
        try spec("""
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"state":\(state),
         "root":{"type":"text","text":"hi"}}
        """)
    }

    private func action(_ json: String) throws -> OverlayAction {
        try JSONDecoder().decode(OverlayAction.self, from: Data(json.utf8))
    }

    // MARK: Sequences

    func testSequencesSurviveDismissAndReshowOfTheSameId() throws {
        var session = OverlaySession()
        let emit = try action(#"{"type":"emit","name":"tap"}"#)
        try session.show(textSpec(id: "a"))
        XCTAssertEqual(session.run([emit]).map(\.sequence), [1])
        XCTAssertEqual(session.dismiss(reason: .user).map(\.sequence), [2])
        try session.show(textSpec(id: "a"))
        XCTAssertEqual(session.run([emit]).map(\.sequence), [3])
    }

    func testSequencesSurviveShowingAnotherIdInBetween() throws {
        var session = OverlaySession()
        let emit = try action(#"{"type":"emit","name":"tap"}"#)
        try session.show(textSpec(id: "a"))
        _ = session.run([emit])
        try session.show(textSpec(id: "b"))
        XCTAssertEqual(session.run([emit]).map(\.sequence), [1])
        try session.show(textSpec(id: "a"))
        XCTAssertEqual(session.run([emit]).map(\.sequence), [2])
    }

    // MARK: Dismissal

    func testAgentDismissalEmitsOneTerminalEventWithItsReason() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a", state: #"{"n":1}"#))
        let events = session.dismiss(reason: .agent)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.kind, "dismissed")
        XCTAssertEqual(events.first?.id, "a")
        XCTAssertEqual(events.first?.payload, .object(["reason": .string("agent")]))
        XCTAssertEqual(events.first?.state, ["n": .number(1)])
        XCTAssertFalse(session.isShown)
        XCTAssertEqual(session.dismiss(reason: .agent), [])
    }

    func testDismissActionStopsTheRemainingActions() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a"))
        let events = try session.run([
            action(#"{"type":"dismiss"}"#),
            action(#"{"type":"emit","name":"late"}"#),
        ])
        XCTAssertEqual(events.map(\.kind), ["dismissed"])
        XCTAssertEqual(events.first?.payload, .object(["reason": .string("user")]))
    }

    // MARK: Change events

    func testTextChangeEmitsChangeOncePerChangedValue() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a", state: #"{"name":""}"#))
        let events = session.change(key: "name", value: .string("Al"))
        XCTAssertEqual(events.map(\.kind), ["emit"])
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertEqual(events.first?.payload, .object(["key": .string("name"), "value": .string("Al")]))
        XCTAssertEqual(events.first?.state["name"], .string("Al"))
        XCTAssertEqual(session.change(key: "name", value: .string("Al")), [])
    }

    func testSetStateStaysSilent() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a", state: #"{"n":1}"#))
        XCTAssertEqual(try session.run([action(#"{"type":"setState","key":"n","value":2}"#)]), [])
        XCTAssertEqual(session.state["n"], .number(2))
    }

    func testToggleControlFlipsTheBoundBooleanThenRunsItsActions() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a", state: #"{"on":false,"label":"x"}"#))
        let events = try session.toggle(key: "on", then: [action(#"{"type":"emit","name":"flipped"}"#)])
        XCTAssertEqual(events.map(\.name), ["change", "flipped"])
        XCTAssertEqual(session.state["on"], .bool(true))
        XCTAssertEqual(session.toggle(key: "label", then: []), [], "a non-boolean key leaves the control inert")
    }

    func testSelectDrivesThePagerWhenPresentElseTheStateKey() throws {
        var session = OverlaySession()
        try session.show(spec("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"state":{"tab":0},
         "root":{"type":"pager","id":"p","children":[{"type":"spacer"},{"type":"spacer"}]}}
        """))
        XCTAssertEqual(session.select(index: 1, pager: "p", key: "tab").map(\.kind), ["page_changed"])
        XCTAssertEqual(session.state["tab"], .number(0))
        XCTAssertEqual(session.select(index: 2, pager: nil, key: "tab").map(\.name), ["change"])
        XCTAssertEqual(session.state["tab"], .number(2))
    }

    // MARK: Actions

    func testToggleAndIncrementActionsMutateStateSilently() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a", state: #"{"on":true,"n":1,"s":"x"}"#))
        let events = try session.run([
            action(#"{"type":"toggle","key":"on"}"#),
            action(#"{"type":"increment","key":"n"}"#),
            action(#"{"type":"increment","key":"n","by":2.5}"#),
            action(#"{"type":"increment","key":"s"}"#),
            action(#"{"type":"toggle","key":"s"}"#),
        ])
        XCTAssertEqual(events, [])
        XCTAssertEqual(session.state, ["on": .bool(false), "n": .number(4.5), "s": .string("x")])
    }

    func testSetPageClampsAndEmitsOnlyOnChange() throws {
        var session = OverlaySession()
        try session.show(spec("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"pager","id":"p","children":[{"type":"spacer"},{"type":"spacer"}]}}
        """))
        let next = try action(#"{"type":"setPage","pager":"p","page":"next"}"#)
        XCTAssertEqual(session.run([next]).map(\.payload), [.number(1)])
        XCTAssertEqual(session.run([next]), [])
        XCTAssertEqual(session.pages["p"], 1)
    }

    private func pagerSpec(id: String = "a", pages count: Int, state: String = "{}") throws -> OverlaySpec {
        let pages = Array(repeating: #"{"type":"spacer"}"#, count: count).joined(separator: ",")
        return try spec("""
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"state":\(state),
         "root":{"type":"pager","id":"p","children":[\(pages)]}}
        """)
    }

    func testSameIdShowKeepsPagerPosition() throws {
        var session = OverlaySession()
        try session.show(pagerSpec(pages: 3))
        _ = session.setPage("p", 2)
        try session.show(pagerSpec(pages: 3))
        XCTAssertEqual(session.pages["p"], 2)
    }

    func testSameIdShowClampsPagerPositionToTheNewPageCount() throws {
        var session = OverlaySession()
        try session.show(pagerSpec(pages: 3))
        _ = session.setPage("p", 2)
        try session.show(pagerSpec(pages: 2))
        XCTAssertEqual(session.pages["p"], 1)
        XCTAssertEqual(session.setPage("p", 5), [])
    }

    func testSameIdShowStartsNewPagersOnTheFirstPage() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a"))
        try session.show(pagerSpec(pages: 3))
        XCTAssertEqual(session.pages, ["p": 0])
    }

    func testSameIdShowStateIsAuthoritative() throws {
        var session = OverlaySession()
        try session.show(textSpec(id: "a", state: #"{"n":1,"gone":true}"#))
        _ = try session.run([action(#"{"type":"setState","key":"n","value":9}"#)])
        try session.show(textSpec(id: "a", state: #"{"n":2}"#))
        XCTAssertEqual(session.state, ["n": .number(2)])
    }

    func testResetStartsFreshOnTheSameId() throws {
        var session = OverlaySession()
        try session.show(pagerSpec(pages: 3, state: #"{"n":1}"#))
        _ = session.setPage("p", 2)
        try session.show(pagerSpec(pages: 3, state: #"{"n":5}"#), reset: true)
        XCTAssertEqual(session.pages["p"], 0)
        XCTAssertEqual(session.state, ["n": .number(5)])
    }

    func testDifferentIdShowNeverKeepsPages() throws {
        var session = OverlaySession()
        try session.show(pagerSpec(id: "a", pages: 3))
        _ = session.setPage("p", 2)
        try session.show(pagerSpec(id: "b", pages: 3))
        XCTAssertEqual(session.pages["p"], 0)
    }

    func testReshowAfterDismissalStartsFresh() throws {
        var session = OverlaySession()
        try session.show(pagerSpec(pages: 3))
        _ = session.setPage("p", 2)
        _ = session.dismiss(reason: .agent)
        try session.show(pagerSpec(pages: 3))
        XCTAssertEqual(session.pages["p"], 0)
    }

    func testSameIdShowAndResetContinueEventSequences() throws {
        var session = OverlaySession()
        let emit = try action(#"{"type":"emit","name":"tap"}"#)
        try session.show(textSpec(id: "a"))
        XCTAssertEqual(session.run([emit]).map(\.sequence), [1])
        try session.show(textSpec(id: "a"))
        XCTAssertEqual(session.run([emit]).map(\.sequence), [2])
        try session.show(textSpec(id: "a"), reset: true)
        XCTAssertEqual(session.run([emit]).map(\.sequence), [3])
    }

    // MARK: Wire shape

    func testWireObjectSerializesToTheProtocolShape() throws {
        let event = OverlayEvent(
            id: "a",
            sequence: 4,
            kind: "emit",
            name: nil,
            payload: .array([.bool(true), .null]),
            state: ["k": .string("v")],
            pages: ["p": 1]
        )
        let data = try JSONSerialization.data(withJSONObject: event.wireObject(timestamp: 9), options: .sortedKeys)
        XCTAssertEqual(
            String(data: data, encoding: .utf8),
            #"{"id":"a","kind":"emit","name":null,"pages":{"p":1},"payload":[true,null],"#
                + #""sequence":4,"state":{"k":"v"},"timestamp":9,"type":"overlay_event"}"#
        )
    }

    // MARK: Test hooks

    func testSimulateTapRunsTheTaggedNodesOnTapAndSequencesEvents() throws {
        var session = OverlaySession()
        try session.show(spec("""
        {"id":"t","window":{"placement":{"type":"fullscreen"}},"state":{"liked":false},
         "root":{"type":"column","children":[
           {"type":"text","testTag":"like","text":"Like",
            "onTap":[{"type":"setState","key":"liked","value":true},{"type":"emit","name":"liked"}]}]}}
        """))
        let first = try session.simulateTap(identifier: "like").get()
        let second = try session.simulateTap(identifier: "like").get()
        XCTAssertEqual(first.map(\.name), ["liked"])
        XCTAssertEqual(first.map(\.sequence), [1])
        XCTAssertEqual(second.map(\.sequence), [2])
        XCTAssertEqual(session.state["liked"], .bool(true))
    }

    func testSimulateTapFailuresAreTyped() throws {
        var session = OverlaySession()
        XCTAssertEqual(session.simulateTap(identifier: "x").failureValue, .notShown)
        try session.show(spec("""
        {"id":"t","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"column","children":[{"type":"text","testTag":"plain","text":"hi"}]}}
        """))
        XCTAssertEqual(session.simulateTap(identifier: "missing").failureValue, .notFound)
        XCTAssertEqual(session.simulateTap(identifier: "plain").failureValue, .notTappable)
    }

    func testTestHooksAreRejectedUnlessTheLaunchFlagIsSet() {
        XCTAssertFalse(OverlayTestHooks.isEnabled(environment: [:]))
        XCTAssertFalse(OverlayTestHooks.isEnabled(environment: [OverlayTestHooks.environmentKey: "0"]))
        XCTAssertTrue(OverlayTestHooks.isEnabled(environment: [OverlayTestHooks.environmentKey: "1"]))
        XCTAssertNotNil(OverlayTestHooks.rejection(requestType: "simulate_tap", enabled: false))
        XCTAssertNil(OverlayTestHooks.rejection(requestType: "simulate_tap", enabled: true))
        XCTAssertNil(OverlayTestHooks.rejection(requestType: "show_overlay", enabled: false))
    }
}

extension Result {
    fileprivate var failureValue: Failure? {
        if case let .failure(error) = self { return error }
        return nil
    }
}
