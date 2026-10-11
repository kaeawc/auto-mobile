@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Text-field typing (`change`) and `setStates` go through the same validator as a tap (#11562),
/// ported from Android's `PrototypeRuntime.textChange` and its test table: a rejected write changes
/// nothing and emits nothing, including the spec byte cap.
final class PrototypeValidatedWritesTests: XCTestCase {
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

    private var oversize: String {
        String(repeating: "x", count: PrototypeLimits.maxSpecBytes + 1)
    }

    // MARK: change

    func testTypingEmitsOneChangeAndADuplicateValueIsSilent() throws {
        var session = try shown()
        let events = session.change(key: "query", value: .string("typed"))
        XCTAssertEqual(session.state["query"], .string("typed"))
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertTrue(session.change(key: "query", value: .string("typed")).isEmpty)
    }

    func testTypingIsDroppedWhenNothingIsShown() {
        var session = PrototypeSession()
        XCTAssertTrue(session.change(key: "query", value: .string("x")).isEmpty)
    }

    func testTypingIntoAKeyBoundToASwitchIsRejected() throws {
        var session = try shown(state: #"{"flag":true}"#, children: #"{"type":"switch","stateKey":"flag"}"#)
        let events = session.change(key: "flag", value: .string("typed"))
        XCTAssertEqual(session.state["flag"], .bool(true), "a boolean binding must stay boolean")
        XCTAssertTrue(events.isEmpty)
    }

    func testTypingIntoAKeyBoundToASliderIsRejected() throws {
        var session = try shown(state: #"{"v":3}"#, children: #"{"type":"slider","stateKey":"v","min":0,"max":10}"#)
        XCTAssertTrue(session.change(key: "v", value: .string("high")).isEmpty)
        XCTAssertEqual(session.state["v"], .number(3))
    }

    func testAnOversizeEditLeavesTheAcceptedTextAndLaterEditsStillWork() throws {
        var session = try shown()
        XCTAssertEqual(session.change(key: "query", value: .string("ok!")).count, 1)
        let events = session.change(key: "query", value: .string(oversize))
        XCTAssertEqual(session.state["query"], .string("ok!"))
        XCTAssertTrue(events.isEmpty, "a rejected edit emits nothing")
        XCTAssertEqual(session.change(key: "query", value: .string("ok!!")).count, 1)
        XCTAssertEqual(session.state["query"], .string("ok!!"))
    }

    func testTheCapIsExactlyTheSpecByteLimit() throws {
        // `"` + `"` around the value and the `{"query":}` frame make the state JSON 11 bytes + value.
        var session = try shown(state: #"{"query":""}"#)
        let room = PrototypeLimits.maxSpecBytes - PrototypeStateValidator.stateBytes(["query": .string("")])
        XCTAssertEqual(session.change(key: "query", value: .string(String(repeating: "a", count: room))).count, 1)
        XCTAssertTrue(session.change(key: "query", value: .string(String(repeating: "b", count: room + 1))).isEmpty)
    }

    func testMultibyteTextCountsItsUtf8Bytes() throws {
        var session = try shown(state: #"{"query":""}"#)
        let room = PrototypeLimits.maxSpecBytes - PrototypeStateValidator.stateBytes(["query": .string("")])
        // Three-byte scalars: fewer characters than `room`, more bytes.
        let characters = room / 3 + 1
        XCTAssertTrue(
            session.change(key: "query", value: .string(String(repeating: "\u{20AC}", count: characters)))
                .isEmpty
        )
        XCTAssertEqual(
            session.change(key: "query", value: .string(String(repeating: "\u{20AC}", count: room / 3))).count,
            1
        )
    }

    func testTheRestOfTheShownSpecCountsTowardTheCap() throws {
        var session = try shown(state: #"{"query":""}"#, specBytes: PrototypeLimits.maxSpecBytes - 100)
        XCTAssertEqual(session.change(key: "query", value: .string(String(repeating: "a", count: 50))).count, 1)
        XCTAssertTrue(session.change(key: "query", value: .string(String(repeating: "a", count: 200))).isEmpty)
    }

    func testAnOversizeEditIsRejectedUnderASessionThatKnowsNoSpecSize() throws {
        var session = try shown(specBytes: nil)
        XCTAssertTrue(session.change(key: "query", value: .string(oversize)).isEmpty)
    }

    // MARK: setStates

    func testSetStatesAppliesAllKeysAndReportsOneChange() throws {
        var session = try shown(state: #"{"a":1,"b":"x"}"#, children: #"{"type":"textField","stateKey":"b"}"#)
        let events = session.setStates([("a", .number(2)), ("b", .string("y"))])
        XCTAssertEqual(session.state["a"], .number(2))
        XCTAssertEqual(session.state["b"], .string("y"))
        XCTAssertEqual(events.count, 1)
    }

    func testSetStatesWithOneInvalidValueWritesNoneOfThem() throws {
        var session = try shown(
            state: #"{"v":3,"n":1}"#,
            children: #"{"type":"slider","stateKey":"v","min":0,"max":10}"#
        )
        let events = session.setStates([("n", .number(2)), ("v", .number(99))])
        XCTAssertEqual(session.state["n"], .number(1))
        XCTAssertEqual(session.state["v"], .number(3))
        XCTAssertTrue(events.isEmpty)
    }

    func testSetStatesWithAHugeTextValueIsRejected() throws {
        var session = try shown()
        let events = session.setStates([("query", .string(oversize))])
        XCTAssertEqual(session.state["query"], .string("ok"))
        XCTAssertTrue(events.isEmpty)
    }

    func testSetStatesThatNetNoChangeEmitsNothingAndRepeatedKeysReportOnce() throws {
        var session = try shown(state: #"{"a":1,"b":1}"#, children: #"{"type":"text","text":"hi"}"#)
        XCTAssertTrue(session.setStates([("a", .number(2)), ("a", .number(1))]).isEmpty, "a key back at its value")
        let events = session.setStates([("b", .number(5)), ("b", .number(6))])
        XCTAssertEqual(session.state["b"], .number(6), "the last write to a key wins")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.payload, .object(["key": .string("b"), "value": .number(6)]))
    }

    func testSetStatesIsDroppedWhenNothingIsShown() {
        var session = PrototypeSession()
        XCTAssertTrue(session.setStates([("a", .number(1))]).isEmpty)
    }

    // MARK: Taps share the cap

    func testATapWritingAHugeTextValueIsRejected() throws {
        var session = try shown()
        let action = try JSONDecoder().decode(
            PrototypeAction.self,
            from: Data(#"{"type":"setState","key":"query","value":"\#(oversize)"}"#.utf8)
        )
        XCTAssertTrue(session.run([action]).isEmpty)
        XCTAssertEqual(session.state["query"], .string("ok"))
    }
}
