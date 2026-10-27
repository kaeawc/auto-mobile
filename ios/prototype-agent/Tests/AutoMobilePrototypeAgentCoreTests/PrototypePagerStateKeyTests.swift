@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePagerStateKeyTests: XCTestCase {
    private func spec(_ page: Int = 0, count: Int = 3) throws -> PrototypeSpec {
        let children = Array(repeating: #"{"type":"text","text":"page"}"#, count: count).joined(separator: ",")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"deck","window":{"placement":{"type":"fullscreen"}},"state":{"page":\(page)},
        "root":{"type":"pager","id":"deck","stateKey":"page","children":[\(children)]}}
        """.utf8))
    }

    func testSwipeWritesKeyAndBothEventsWithoutEcho() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let events = session.setPage("deck", 2)
        XCTAssertEqual(events.map(\.name), ["deck", "change"])
        XCTAssertTrue(events.allSatisfy { $0.state["page"] == .number(2) && $0.pages["deck"] == 2 })
        XCTAssertEqual(session.state["page"], .number(2))
        XCTAssertTrue(session.setPage("deck", 2).isEmpty)
    }

    func testStateActionsClampAndReplacingShowUsesNewState() throws {
        var session = PrototypeSession()
        try session.show(spec(1))
        XCTAssertEqual(session.pages["deck"], 1)
        func action(_ value: Int) throws -> PrototypeAction {
            try JSONDecoder().decode(PrototypeAction.self, from: Data("""
            {"type":"setState","key":"page","value":\(value)}
            """.utf8))
        }
        _ = try session.run([action(99)])
        XCTAssertEqual(session.pages["deck"], 2)
        XCTAssertEqual(session.state["page"], .number(2))
        _ = try session.run([action(-99)])
        XCTAssertEqual(session.pages["deck"], 0)
        try session.show(spec(99, count: 2))
        XCTAssertEqual(session.pages["deck"], 1)
        XCTAssertEqual(session.state["page"], .number(1))
        try session.show(spec(0, count: 2))
        XCTAssertEqual(session.pages["deck"], 0)
    }

    func testNavigationSteppingAndPatchShareTheSelection() throws {
        var session = PrototypeSession()
        try session.show(spec())
        func action(_ json: String) throws -> PrototypeAction {
            try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
        }
        _ = try session.run([action(#"{"type":"increment","key":"page"}"#)])
        XCTAssertEqual(session.pages["deck"], 1)
        _ = try session.run([action(#"{"type":"decrement","key":"page"}"#)])
        XCTAssertEqual(session.pages["deck"], 0)
        _ = session.select(index: 2, pager: "deck", key: nil, then: [])
        XCTAssertEqual(session.state["page"], .number(2))
        _ = try session.run([action(#"{"type":"setPage","pager":"deck","page":1}"#)])
        XCTAssertEqual(session.state["page"], .number(1))
        let ops = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"[{"op":"replace","path":"/state/page","value":-99}]"#.utf8)
        )
        let (outcome, events) = session.patch(id: "deck", baseRevision: session.dataRevision, ops: ops)
        guard case .applied = outcome else { return XCTFail("Patch refused") }
        XCTAssertEqual(events.map(\.name), ["change"])
        XCTAssertEqual(session.pages["deck"], 0)
        XCTAssertEqual(session.state["page"], .number(0))
    }
}
