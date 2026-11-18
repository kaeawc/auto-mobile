@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Device-free realtime action lists use the same synchronous session seam as the runtime fakes.
final class PrototypeStateBindingTests: XCTestCase {
    private func session(bound: Bool = false) throws -> PrototypeSession {
        let root = bound ? #"{"type":"switch","stateKey":"enabled"}"# : #"{"type":"text","text":"Value"}"#
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"bindings","window":{"placement":{"type":"fullscreen"}},
         "state":{"n":0,"enabled":true},"data":{"first":[],"second":[]},"root":\(root)}
        """.utf8))
        var session = PrototypeSession()
        session.show(spec)
        return session
    }

    private func setState(_ binding: JSONValue, key: String = "n") -> JSONValue {
        .object(["type": .string("setState"), "key": .string(key), "value": binding])
    }

    private var sideEffects: [JSONValue] {
        [
            .object(["type": .string("increment"), "key": .string("n")]),
            .object([
                "type": .string("setData"), "path": .string("/data/proof"),
                "value": .object(["value": .bool(true)]),
            ]),
            .object(["type": .string("emit"), "name": .string("ran")]),
        ]
    }

    private func assertRefused(
        event: JSONValue, platform: [String: JSONValue] = [:],
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        for source in ["event", "platform"] {
            var session = try session()
            try session.setPlatformState(platform)
            let state = session.state
            let data = session.data
            let revision = session.dataRevision
            let sequence = session.lastSequence
            let actions = sideEffects + [setState(.object([source: .string("/value")]))]
            XCTAssertTrue(try session.runChannelActions(actions, event: event).isEmpty, file: file, line: line)
            XCTAssertEqual(session.state, state, file: file, line: line)
            XCTAssertEqual(session.data, data, file: file, line: line)
            XCTAssertEqual(session.dataRevision, revision, file: file, line: line)
            XCTAssertEqual(session.lastSequence, sequence, file: file, line: line)
        }
    }

    func testMissingStateBindingSourceRefusesWholeList() throws {
        try assertRefused(event: .object([:]))
        var session = try session()
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode(
            sideEffects + [setState(.object(["event": .string("")]))]
        ))
        XCTAssertTrue(session.run(actions).isEmpty) // no handler event is installed
        XCTAssertEqual(session.state["n"], .number(0))
        XCTAssertNil(session.data?["proof"])
    }

    func testObjectStateBindingRefusesWholeList() throws {
        let value: JSONValue = .object(["count": .number(2)])
        try assertRefused(event: .object(["value": value]), platform: ["value": value])
    }

    func testArrayStateBindingRefusesWholeList() throws {
        let value: JSONValue = .array([.number(2)])
        try assertRefused(event: .object(["value": value]), platform: ["value": value])
    }

    func testNullStateBindingRefusesWholeList() throws {
        try assertRefused(event: .object(["value": .null]), platform: ["value": .null])
    }

    func testScalarStateBindingsWriteStringsNumbersAndBooleans() throws {
        let values: [JSONValue] = [.string("frame"), .number(0), .bool(false)]
        for source in ["event", "platform"] {
            var session = try session()
            for value in values {
                try session.setPlatformState(["value": value])
                let binding = setState(.object([source: .string("/value")]))
                let events = try session.runChannelActions([binding], event: .object(["value": value]))
                XCTAssertEqual(session.state["n"], value)
                XCTAssertEqual(events.last?.payload, .object(["key": .string("n"), "value": value]))
            }
        }
    }

    func testEmptyEventPointerWritesWholeScalarFrame() throws {
        var session = try session()
        let values: [JSONValue] = [.string("frame"), .number(2), .bool(false)]
        for value in values {
            _ = try session.runChannelActions([setState(.object(["event": .string("")]))], event: value)
            XCTAssertEqual(session.state["n"], value)
        }
    }

    func testEmptyEventPointerRefusesWholeNonScalarOrNullFrame() throws {
        var session = try session()
        let values: [JSONValue] = [.object([:]), .array([]), .null]
        for value in values {
            let actions = sideEffects + [setState(.object(["event": .string("")]))]
            XCTAssertTrue(try session.runChannelActions(actions, event: value).isEmpty)
            XCTAssertEqual(session.state["n"], .number(0))
            XCTAssertNil(session.data?["proof"])
        }
    }

    func testControlStateBindingsPlanResolvedValuesAndRefuseOwnWritesAtomically() throws {
        var session = try session()
        try session.setPlatformState(["value": .number(2)])
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode([
            setState(.object(["platform": .string("/value")])),
            .object(["type": .string("increment"), "key": .string("n")]),
        ]))
        _ = session.control(own: [("enabled", .bool(false))], then: actions)
        XCTAssertEqual(session.state["n"], .number(3))
        XCTAssertEqual(session.state["enabled"], .bool(false))
        // A non-scalar refuses the control's own write as well as the entire action list.
        try session.setPlatformState(["value": .object([:])])
        XCTAssertTrue(session.control(own: [("enabled", .bool(true))], then: actions).isEmpty)
        XCTAssertEqual(session.state["n"], .number(3))
        XCTAssertEqual(session.state["enabled"], .bool(false))
    }

    private func assertRequestFollowUpUsesOwnEvent(
        append: Bool, file: StaticString = #filePath, line: UInt = #line
    ) throws {
        // Exercise both success and error callbacks without a transport, clock, or scheduler.
        for succeeds in [true, false] {
            var session = try session(bound: true)
            let followUp = sideEffects + [setState(.object(["event": .string("/value")]), key: "enabled")]
            for (target, value) in [("first", JSONValue.bool(false)), ("second", .number(2))] {
                var request: [String: JSONValue] = [
                    "type": .string("request"), "url": .string("https://example.com/\(target)"),
                ]
                request[succeeds ? "onSuccess" : "onError"] = .array(followUp)
                if append {
                    request["append"] = .object(["from": .string("/items"), "to": .string("/data/\(target)")])
                }
                _ = try session.runChannelActions([.object(request)], event: .object(["value": value]))
            }
            XCTAssertEqual(session.takeRequestCommands().count, 2, file: file, line: line)
            let response: PrototypeRequestResponse = succeeds
                ? .received(status: 200, headers: [:], body: .object(["items": .array([])]), durationMs: 0)
                : .failed(.init(.network, "offline"), durationMs: 0)
            // The second request's numeric event fails the switch validation before side effects.
            let refused = session.completeRequest("r-2", response)
            XCTAssertFalse(refused.contains { $0.name == "ran" }, file: file, line: line)
            XCTAssertEqual(session.state["enabled"], .bool(true), file: file, line: line)
            XCTAssertEqual(session.state["n"], .number(0), file: file, line: line)
            XCTAssertNil(session.data?["proof"], file: file, line: line)
            // The first request restores its own boolean event before planning the same list.
            let accepted = session.completeRequest("r-1", response)
            XCTAssertTrue(accepted.contains { $0.name == "ran" }, file: file, line: line)
            XCTAssertEqual(session.state["enabled"], .bool(false), file: file, line: line)
            XCTAssertEqual(session.state["n"], .number(1), file: file, line: line)
            XCTAssertEqual(session.data?["proof"], .bool(true), file: file, line: line)
            // Completion restores the ambient absent event after the callback.
            let actions = try JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode(followUp))
            XCTAssertTrue(session.run(actions).isEmpty, file: file, line: line)
            XCTAssertEqual(session.state["n"], .number(1), file: file, line: line)
        }
    }

    func testRequestFollowUpStateBindingIsValidatedAgainstItsOwnEvent() throws {
        try assertRequestFollowUpUsesOwnEvent(append: false)
    }

    func testAppendRequestFollowUpStateBindingIsValidatedAgainstItsOwnEvent() throws {
        try assertRequestFollowUpUsesOwnEvent(append: true)
    }
}
