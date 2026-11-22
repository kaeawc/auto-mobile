@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeSecureRedactionTests: XCTestCase {
    private static let source = Data(#"""
    {"id":"vault","window":{"placement":{"type":"fullscreen"}},
     "requires":{"platform":["secureStorage"]},"state":{"token":"tok-test-1","pin":"","count":0},
     "storage":{"version":1,"keys":["state:count"],"secure":["state:token","state:pin"]},
     "root":{"type":"text","text":"vault"}}
    """#.utf8)

    override static func setUp() {
        super.setUp()
        do {
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: source)
        } catch { XCTFail("Warmup: \(error)") }
    }

    private func session() throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Self.source))
        return session
    }

    private func json(_ bytes: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: bytes)
    }

    private func assertPublicSnapshot(
        _ event: PrototypeEvent,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        throws
    {
        XCTAssertEqual(event.state, ["count": .number(0)], file: file, line: line)
        XCTAssertEqual(try json(event.stateJSON), .object(["count": .number(0)]), file: file, line: line)
        XCTAssertEqual(
            try json(event.wireJSON).objectFields?["state"], .object(["count": .number(0)]), file: file, line: line
        )
        XCTAssertNil(event.wireJSON.range(of: Data("tok-test-1".utf8)), file: file, line: line)
    }

    func testRedactUsesStorageKeyParserAndLeavesInputAndPublicKeysAlone() {
        let state: [String: JSONValue] = ["token": .string("tok-test-1"), "count": .number(0), "pin": .string("")]
        XCTAssertEqual(PrototypeSecureStorageRules.redact(
            state: state, secure: ["state:token", "state:pin", "state:token", "data:/count", "stack:count", "state:"]
        ), ["count": .number(0)])
        XCTAssertEqual(state["token"], .string("tok-test-1"))
        XCTAssertEqual(PrototypeSecureStorageRules.redact(state: state, secure: []), state)
    }

    func testStatusStateOmitsSecureKeysAndClearsAfterDismissal() throws {
        var session = try session()
        XCTAssertEqual(session.publicState, ["count": .number(0)])
        _ = session.dismiss(reason: .agent)
        XCTAssertEqual(session.publicState, [:])
        XCTAssertEqual(session.state["token"], .string("tok-test-1"), "Live state outlives the dismissed spec")
    }

    func testAuthoredEmitRedactsWireAndEmbeddedSnapshotsAndKeepsPublicContext() throws {
        var session = try session()
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: Data(#"""
        [{"type":"emit","name":"submit","payload":{"ok":true},"context":{"count":{"state":"count"}}}]
        """#.utf8))
        let event = try XCTUnwrap(session.run(actions).first)
        try assertPublicSnapshot(event)
        XCTAssertEqual(event.payload, .object(["ok": .bool(true)]))
        XCTAssertEqual(event.context, ["count": .number(0)])
        XCTAssertEqual(session.state["token"], .string("tok-test-1"))
    }

    func testDismissalSnapshotIsRedactedBeforeSpecDisappears() throws {
        var session = try session()
        let event = try XCTUnwrap(session.dismiss(reason: .agent).first)
        XCTAssertNil(session.spec)
        try assertPublicSnapshot(event)
    }

    func testSingleSecureChangeKeepsKeyButOmitsValueFromEveryEventEncoding() throws {
        var session = try session()
        let event = try XCTUnwrap(session.change(key: "pin", value: .string("tok-test-1")).first)
        XCTAssertEqual(event.payload, .object(["key": .string("pin")]))
        XCTAssertEqual(try json(event.payloadJSON), .object(["key": .string("pin")]))
        try assertPublicSnapshot(event)
        XCTAssertEqual(session.state["pin"], .string("tok-test-1"))
    }

    func testBatchedChangesOmitSecureValuesAndKeepPublicValues() throws {
        var session = try session()
        let event = try XCTUnwrap(session.setStates([
            ("pin", .string("tok-test-1")), ("count", .number(1)),
        ]).first)
        XCTAssertEqual(event.payload.objectFields?["values"], .object(["count": .number(1)]))
        XCTAssertEqual(event.state, ["count": .number(1)])
        XCTAssertNil(event.wireJSON.range(of: Data("tok-test-1".utf8)))
    }

    func testSinglePublicChangeRetainsItsValueAndOmitsOtherSecureState() throws {
        var session = try session()
        let event = try XCTUnwrap(session.change(key: "count", value: .number(1)).first)
        XCTAssertEqual(event.payload, .object(["key": .string("count"), "value": .number(1)]))
        XCTAssertEqual(event.state, ["count": .number(1)])
    }

    func testPatchConflictReplyOmitsSecureStateAndKeepsPublicConflicts() throws {
        var session = try session()
        let base = session.dataRevision
        _ = session.setStates([("pin", .string("tok-test-1")), ("count", .number(1))])
        let ops = try json(Data(#"""
        [{"op":"replace","path":"/state/pin","value":""},{"op":"replace","path":"/state/count","value":2}]
        """#.utf8))
        let (outcome, events) = session.patch(id: "vault", baseRevision: base, ops: ops)
        XCTAssertFalse(outcome.reply.success)
        XCTAssertTrue(events.isEmpty)
        let reply = try JSONSerialization.data(withJSONObject: outcome.reply.extra)
        XCTAssertEqual(
            try json(reply).objectFields?["conflict"]?.objectFields?["state"],
            .object(["count": .number(1)])
        )
        XCTAssertNil(reply.range(of: Data("tok-test-1".utf8)))
    }
}
