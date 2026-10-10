@testable import AutoMobilePrototypeAgentCore
import XCTest

/// One tap is one unit (#11408, #11551), ported from Android's `PrototypeRuntimeTest`: every state
/// write of an interaction is planned and validated against the controls bound to its key before
/// anything is applied, and a rejected write drops the whole interaction with no event.
final class PrototypeAtomicTapTests: XCTestCase {
    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }

    private func shown(state: String, children: String) throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":\(state),
         "root":{"type":"column","children":[\(children)]}}
        """))
        return session
    }

    // MARK: Increment and decrement against a bound control

    func testIncrementPastASliderMaximumIsRejectedLikeAndroid() throws {
        var session = try shown(
            state: #"{"v":10}"#,
            children: #"{"type":"slider","stateKey":"v","min":0,"max":10}"#
        )
        let events = try session.run([action(#"{"type":"increment","key":"v"}"#)])
        XCTAssertEqual(session.state["v"], .number(10), "the slider key must stay within min...max")
        XCTAssertTrue(events.isEmpty, "a rejected write emits no change event")
    }

    func testDecrementBelowZeroOnABoundTabBarIsRejectedLikeAndroid() throws {
        var session = try shown(
            state: #"{"tab":0}"#,
            children: #"{"type":"tabBar","stateKey":"tab","items":[{"label":"A"},{"label":"B"}]}"#
        )
        let events = try session.run([action(#"{"type":"decrement","key":"tab"}"#)])
        XCTAssertEqual(session.state["tab"], .number(0), "a tab index must stay a nonnegative integer")
        XCTAssertTrue(events.isEmpty)
    }

    func testATapHoldingARejectedWriteAppliesNothing() throws {
        var session = try shown(
            state: #"{"flag":false,"v":10}"#,
            children: #"{"type":"slider","stateKey":"v","min":0,"max":10},{"type":"switch","stateKey":"flag"}"#
        )
        let events = try session.run([
            action(#"{"type":"toggle","key":"flag"}"#),
            action(#"{"type":"increment","key":"v"}"#),
        ])
        XCTAssertEqual(session.state["flag"], .bool(false))
        XCTAssertEqual(session.state["v"], .number(10))
        XCTAssertTrue(events.isEmpty)
    }

    func testAnIncrementThatStaysInRangeIsStillApplied() throws {
        var session = try shown(
            state: #"{"v":3,"n":1}"#,
            children: #"{"type":"slider","stateKey":"v","min":0,"max":10}"#
        )
        let events = try session.run([
            action(#"{"type":"increment","key":"v","by":7}"#),
            action(#"{"type":"increment","key":"n"}"#),
            action(#"{"type":"decrement","key":"v","by":10}"#),
        ])
        XCTAssertEqual(session.state["v"], .number(0))
        XCTAssertEqual(session.state["n"], .number(2), "a key no control binds is unconstrained")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "change")
    }

    func testAnIntermediateOutOfRangeValueIsRejectedEvenIfTheNetResultFits() throws {
        var session = try shown(
            state: #"{"v":9}"#,
            children: #"{"type":"slider","stateKey":"v","min":0,"max":10}"#
        )
        let events = try session.run([
            action(#"{"type":"increment","key":"v","by":5}"#),
            action(#"{"type":"decrement","key":"v","by":5}"#),
        ])
        XCTAssertEqual(session.state["v"], .number(9))
        XCTAssertTrue(events.isEmpty)
    }

    // MARK: Rejected writes drop the whole list, including emits and page moves

    private let fieldChildren = """
    {"type":"pager","id":"pager","children":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},
    {"type":"textField","stateKey":"query"}
    """
    private let fieldState = #"{"flag":false,"query":""}"#
    private let breaksBinding = #"{"type":"setState","key":"query","value":1}"#

    func testARejectedWriteDropsEarlierEmitsAndPageMovesAndSpendsNoSequence() throws {
        var session = try shown(state: fieldState, children: fieldChildren)
        let events = try session.run([
            action(#"{"type":"emit","name":"before"}"#),
            action(#"{"type":"setState","key":"flag","value":true}"#),
            action(#"{"type":"setPage","pager":"pager","page":"next"}"#),
            action(breaksBinding),
            action(#"{"type":"emit","name":"after"}"#),
        ])
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(session.state["flag"], .bool(false))
        XCTAssertEqual(session.pages["pager"], 0)
        XCTAssertEqual(session.lastSequence, 0)
        let next = try session.run([action(#"{"type":"setState","key":"flag","value":true}"#)])
        XCTAssertEqual(next.map(\.sequence), [1])
    }

    func testAWriteAfterADismissIsNeverValidated() throws {
        var session = try shown(state: fieldState, children: fieldChildren)
        let events = try session.run([
            action(#"{"type":"setState","key":"flag","value":true}"#),
            action(#"{"type":"dismiss"}"#),
            action(breaksBinding),
        ])
        XCTAssertEqual(events.map(\.kind), ["dismissed"])
        XCTAssertEqual(events.first?.state["flag"], .bool(true))
        XCTAssertFalse(session.isShown)
    }

    func testBoundTypesRejectInvalidSetStateAndUnboundKeysAcceptAnyScalar() throws {
        var session = try shown(
            state: #"{"query":"","selected":0,"open":false}"#,
            children: """
            {"type":"textField","stateKey":"query"},
            {"type":"tabBar","stateKey":"selected","items":[{"label":"Tab"}]},
            {"type":"bottomSheet","openWhen":{"key":"open","equals":true},"child":{"type":"spacer"}}
            """
        )
        let rejected = [
            #"{"type":"setState","key":"query","value":1}"#,
            #"{"type":"setState","key":"selected","value":-1}"#,
            #"{"type":"setState","key":"selected","value":0.5}"#,
            #"{"type":"setState","key":"open","value":"true"}"#,
        ]
        for json in rejected {
            XCTAssertTrue(try session.run([action(json)]).isEmpty, json)
        }
        XCTAssertEqual(session.state["query"], .string(""))
        XCTAssertEqual(session.state["selected"], .number(0))
        XCTAssertEqual(session.state["open"], .bool(false))
        let events = try session.run([action(#"{"type":"setState","key":"flag","value":true}"#)])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(session.state["flag"], .bool(true))
    }

    // MARK: A state action in the spec keeps its key's type

    func testASetStateThatRetypesAKeyAStateActionNeedsIsRejected() throws {
        var session = try shown(
            state: #"{"n":1,"on":false}"#,
            children: """
            {"type":"button","label":"+","onTap":[{"type":"increment","key":"n"}]},
            {"type":"button","label":"t","onTap":[{"type":"toggle","key":"on"}]}
            """
        )
        XCTAssertTrue(try session.run([action(#"{"type":"setState","key":"n","value":"x"}"#)]).isEmpty)
        XCTAssertTrue(try session.run([action(#"{"type":"setState","key":"on","value":1}"#)]).isEmpty)
        XCTAssertEqual(session.state["n"], .number(1))
        XCTAssertEqual(session.state["on"], .bool(false))
        XCTAssertEqual(try session.run([action(#"{"type":"setState","key":"n","value":5}"#)]).count, 1)
    }

    // MARK: The validator's rule table

    private func rejection(_ node: String, state: [String: JSONValue]) throws -> String? {
        let root = try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data(#"{"type":"column","children":[\#(node)]}"#.utf8)
        )
        return PrototypeStateValidator.rejection(root: root, state: state)
    }

    func testSliderAndProgressRanges() throws {
        let slider = #"{"type":"slider","stateKey":"v","min":0,"max":10,"step":2}"#
        XCTAssertNil(try rejection(slider, state: ["v": .number(10)]))
        XCTAssertNotNil(try rejection(slider, state: ["v": .number(10.5)]))
        XCTAssertNotNil(try rejection(slider, state: ["v": .number(-0.1)]))
        XCTAssertNotNil(try rejection(slider, state: ["v": .string("3")]))
        XCTAssertNotNil(try rejection(slider, state: [:]))
        XCTAssertNotNil(try rejection(#"{"type":"slider","stateKey":"v","min":5,"max":5}"#, state: ["v": .number(5)]))
        XCTAssertNotNil(try rejection(
            #"{"type":"slider","stateKey":"v","min":0,"max":10,"step":3}"#,
            state: ["v": .number(3)]
        ))
        let progress = #"{"type":"progress","stateKey":"p","max":4}"#
        XCTAssertNil(try rejection(progress, state: ["p": .number(4)]))
        XCTAssertNotNil(try rejection(progress, state: ["p": .number(4.5)]))
        XCTAssertNotNil(try rejection(progress, state: ["p": .number(-1)]))
        XCTAssertNil(try rejection(#"{"type":"progress","stateKey":"p"}"#, state: ["p": .number(1)]))
        XCTAssertNotNil(try rejection(#"{"type":"progress","stateKey":"p"}"#, state: ["p": .number(1.5)]))
        XCTAssertNil(try rejection(#"{"type":"progress"}"#, state: [:]), "an unbound progress is indeterminate")
    }

    func testSelectionTimeAndDateBindings() throws {
        let tabs = #"{"type":"bottomNav","stateKey":"t","items":[{"label":"A"}]}"#
        XCTAssertNil(try rejection(tabs, state: ["t": .number(2)]))
        XCTAssertNotNil(try rejection(tabs, state: ["t": .number(-1)]))
        XCTAssertNotNil(try rejection(tabs, state: ["t": .number(1.5)]))
        XCTAssertNil(
            try rejection(#"{"type":"tabBar","pager":"x","items":[{"label":"A"}]}"#, state: [:]),
            "a pager-bound tab bar has no state key"
        )
        let time = #"{"type":"timePicker","hourKey":"h","minuteKey":"m"}"#
        XCTAssertNil(try rejection(time, state: ["h": .number(23), "m": .number(59)]))
        XCTAssertNotNil(try rejection(time, state: ["h": .number(24), "m": .number(0)]))
        XCTAssertNotNil(try rejection(time, state: ["h": .number(1), "m": .number(60)]))
        XCTAssertNotNil(try rejection(time, state: ["h": .number(1.5), "m": .number(0)]))
        XCTAssertNotNil(try rejection(
            #"{"type":"timePicker","hourKey":"h","minuteKey":"h"}"#,
            state: ["h": .number(1)]
        ))
        let date = #"{"type":"datePicker","stateKey":"d"}"#
        XCTAssertNil(try rejection(date, state: ["d": .string("2024-02-29")]))
        XCTAssertNil(try rejection(date, state: ["d": .string("1900-01-01")]))
        XCTAssertNil(try rejection(date, state: ["d": .string("2100-12-31")]))
        for bad in ["2023-02-29", "1899-12-31", "2101-01-01", "2024-13-01", "2024-1-01", "tomorrow", "2024-04-31"] {
            XCTAssertNotNil(try rejection(date, state: ["d": .string(bad)]), bad)
        }
        XCTAssertNotNil(try rejection(date, state: ["d": .number(20_240_101)]))
    }

    func testTextBooleanAndChoiceBindings() throws {
        XCTAssertNil(try rejection(#"{"type":"textField","stateKey":"q"}"#, state: ["q": .string("")]))
        XCTAssertNotNil(try rejection(#"{"type":"textField","stateKey":"q"}"#, state: ["q": .bool(true)]))
        for type in ["switch", "checkbox"] {
            let node = #"{"type":"\#(type)","stateKey":"f"}"#
            XCTAssertNil(try rejection(node, state: ["f": .bool(false)]))
            XCTAssertNotNil(try rejection(node, state: ["f": .number(1)]))
            XCTAssertNotNil(try rejection(node, state: [:]))
        }
        let radio =
            #"{"type":"radioGroup","stateKey":"c","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}"#
        XCTAssertNil(try rejection(radio, state: ["c": .string("zzz")]))
        XCTAssertNotNil(try rejection(radio, state: ["c": .number(0)]))
        XCTAssertNotNil(try rejection(
            #"{"type":"segmentedButton","stateKey":"c","options":[{"value":"a","label":"A"},{"value":"a","label":"B"}]}"#,
            state: ["c": .string("a")]
        ))
        let filter = #"{"type":"chip","variant":"filter","label":"x","stateKey":"f"}"#
        XCTAssertNil(try rejection(filter, state: ["f": .bool(true)]))
        XCTAssertNotNil(try rejection(filter, state: ["f": .string("true")]))
        XCTAssertNotNil(try rejection(
            #"{"type":"chip","variant":"assist","label":"x","stateKey":"f"}"#,
            state: ["f": .bool(true)]
        ))
    }

    func testListItemTrailingAndModalOpenWhenBindings() throws {
        let item = #"{"type":"listItem","headline":"h","trailing":{"type":"switch","stateKey":"f"}}"#
        XCTAssertNil(try rejection(item, state: ["f": .bool(true)]))
        XCTAssertNotNil(try rejection(item, state: ["f": .string("x")]))
        for type in ["bottomSheet", "dialog", "snackbar"] {
            let modal = #"{"type":"\#(type)","openWhen":{"key":"o","equals":true}}"#
            XCTAssertNil(try rejection(modal, state: [:]), "an absent openWhen key is allowed")
            XCTAssertNil(try rejection(modal, state: ["o": .bool(false)]))
            XCTAssertNotNil(try rejection(modal, state: ["o": .string("true")]))
            XCTAssertNotNil(try rejection(modal, state: ["o": .number(1)]))
        }
    }

    func testRepeatInstancesAreEachValidatedWithTheirOwnKeys() throws {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"a":1,"b":1},
         "root":{"type":"column","repeat":{"as":"s","items":[{"k":"a"},{"k":"b"}]},
           "children":[{"type":"slider","stateKey":"{s.k}","min":0,"max":2}]}}
        """))
        XCTAssertEqual(try session.run([action(#"{"type":"increment","key":"a"}"#)]).count, 1)
        XCTAssertTrue(try session.run([action(#"{"type":"increment","key":"a"}"#)]).isEmpty)
        XCTAssertEqual(session.state["a"], .number(2))
        XCTAssertTrue(try session.run([action(#"{"type":"setState","key":"b","value":3}"#)]).isEmpty)
    }

    // MARK: Controls that write state of their own

    private let controlState = """
    {"flag":false,"query":"","choice":"a","level":1,"hour":7,"minute":30,"tab":0,"open":true}
    """
    private let controlChildren = """
    {"type":"pager","id":"pager","children":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},
    {"type":"textField","stateKey":"query"},
    {"type":"switch","stateKey":"flag"},
    {"type":"radioGroup","stateKey":"choice","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]},
    {"type":"slider","stateKey":"level","min":0,"max":10},
    {"type":"timePicker","hourKey":"hour","minuteKey":"minute"},
    {"type":"tabBar","stateKey":"tab","items":[{"label":"A"},{"label":"B"}]},
    {"type":"dialog","openWhen":{"key":"open","equals":true},"title":"T","confirm":{"label":"OK"}}
    """

    private func controlSession() throws -> PrototypeSession {
        try shown(state: controlState, children: controlChildren)
    }

    /// Every control that writes state of its own, with the action list it then runs.
    private func controls(_ actions: [PrototypeAction]) -> [(String, (inout PrototypeSession) -> [PrototypeEvent])] {
        [
            ("toggle", { $0.toggle(key: "flag", then: actions) }),
            ("choose", { $0.choose(key: "choice", value: "b", then: actions) }),
            ("slide", { $0.slide(key: "level", value: 2, then: actions) }),
            ("setTime", { $0.setTime(hourKey: "hour", minuteKey: "minute", hour: 8, minute: 45, then: actions) }),
            ("select key", { $0.select(index: 1, pager: nil, key: "tab", then: actions) }),
            ("select pager", { $0.select(index: 1, pager: "pager", key: nil, then: actions) }),
            ("closeModal", { session in
                let dialog = session.spec?.root.children?.first { $0.type == "dialog" }
                return session.closeModal(dialog!, then: actions)
            }),
        ]
    }

    func testAControlWhoseActionListIsRejectedAppliesNeitherItsOwnWriteNorTheList() throws {
        let rejected = try [action(#"{"type":"emit","name":"before"}"#), action(breaksBinding)]
        for (name, interact) in controls(rejected) {
            var session = try controlSession()
            let before = session.state
            let events = interact(&session)
            XCTAssertTrue(events.isEmpty, name)
            XCTAssertEqual(session.state, before, name)
            XCTAssertEqual(session.pages["pager"], 0, name)
            XCTAssertEqual(session.lastSequence, 0, name)
        }
    }

    func testAnAcceptedControlReportsItsOwnChangeAndThenItsActionList() throws {
        let accepted = try [
            action(#"{"type":"setState","key":"query","value":"x"}"#),
            action(#"{"type":"emit","name":"done"}"#),
        ]
        let own = [
            "toggle": ["flag"], "choose": ["choice"], "slide": ["level"], "setTime": ["hour", "minute"],
            "select key": ["tab"], "closeModal": ["open"],
        ]
        for (name, interact) in controls(accepted) {
            var session = try controlSession()
            let before = session.state
            let events = interact(&session)
            if let keys = own[name] {
                let first = try XCTUnwrap(events.first, name)
                XCTAssertEqual(first.name, "change", name)
                XCTAssertEqual(first.state["query"], before["query"], name)
                XCTAssertTrue(keys.allSatisfy { first.state[$0] != before[$0] }, name)
            } else {
                XCTAssertEqual(events.first?.kind, "page_changed", name)
            }
            XCTAssertEqual(events.dropFirst().map(\.name), ["done", "change"], name)
            XCTAssertEqual(events.last?.state["query"], .string("x"), name)
            XCTAssertEqual(events.last?.state, session.state, name)
        }
    }

    func testAnInconsistentSpecRejectsEveryWriteLikeAndroidsWholeSpecValidation() throws {
        var session = try shown(
            state: #"{"on":true}"#,
            children: """
            {"type":"switch","stateKey":"on"},
            {"type":"button","label":"x","onTap":[{"type":"increment","key":"on"}]}
            """
        )
        // The spec itself is inconsistent (an increment on a boolean), so no write validates.
        XCTAssertTrue(session.toggle(key: "on", then: []).isEmpty)
        XCTAssertEqual(session.state["on"], .bool(true))
    }
}
