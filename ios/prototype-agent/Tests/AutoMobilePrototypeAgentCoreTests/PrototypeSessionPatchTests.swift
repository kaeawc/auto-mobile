@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `patch_prototype` on the session (#11675): revisions, state conflicts, atomic refusals, the
/// `change` event, the reply shape and the capability the agent advertises once it handles it.
final class PrototypeSessionPatchTests: XCTestCase {
    private static let source = #"""
    {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"count":1,"flag":false},
     "data":{"title":"A","items":["x"]},
     "root":{"type":"column","children":[
       {"type":"text","id":"t","text":"Hello"},
       {"type":"switch","stateKey":"flag"}]}}
    """#

    private func session() throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(Self.source.utf8)))
        return session
    }

    private func ops(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    // MARK: Applied

    /// #13040: the first show is revision 1 and each re-show moves it on, as on Android's controller.
    func testShowRevisionsMatchTheSharedFixtureAndroidReplays() throws {
        struct Show: Decodable { let spec: String; let revision: Int }
        struct Fixture: Decodable { let specs: [String: JSONValue]; let shows: [Show] }
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("revision/show-revisions.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        var session = PrototypeSession()
        for show in fixture.shows {
            let spec = try XCTUnwrap(fixture.specs[show.spec])
            try session.show(JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(spec)))
            XCTAssertEqual(session.dataRevision, show.revision, "show of \(show.spec)")
        }
    }

    func testEveryShowTakesARevisionStartingAtOne() throws {
        var session = PrototypeSession()
        XCTAssertEqual(session.dataRevision, 0, "nothing shown yet")
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(Self.source.utf8))
        session.show(spec)
        XCTAssertEqual(session.dataRevision, 1)
        session.show(spec)
        XCTAssertEqual(session.dataRevision, 2)
    }

    func testDataPatchAppliesWithoutBaseRevisionAndReportsTheNewRevision() throws {
        var session = try session()
        let (outcome, events) = try session.patch(
            id: "p", baseRevision: nil, ops: ops(#"[{"op":"replace","path":"/data/title","value":"B"}]"#)
        )
        XCTAssertEqual(outcome, .applied(revision: 2))
        XCTAssertEqual(session.data?["title"], .string("B"))
        XCTAssertEqual(session.dataRevision, 2)
        XCTAssertTrue(events.isEmpty, "a data patch moves no state key")
    }

    func testStatePatchEmitsOneChangeEventAndKeepsPagesAndTheRest() throws {
        var session = try session()
        let (outcome, events) = try session.patch(
            id: "p", baseRevision: 1, ops: ops(#"[{"op":"replace","path":"/state/count","value":5}]"#)
        )
        XCTAssertEqual(outcome, .applied(revision: 2))
        XCTAssertEqual(session.state["count"], .number(5))
        XCTAssertEqual(session.state["flag"], .bool(false))
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.wireKind, "emit")
        XCTAssertEqual(events.first?.name, "change")
        XCTAssertEqual(events.first?.payload, .object(["key": .string("count"), "value": .number(5)]))
    }

    func testReplaceNodeRebuildsTheDrawnTree() throws {
        var session = try session()
        let (outcome, _) = try session.patch(
            id: "p", baseRevision: nil,
            ops: ops(#"[{"op":"replaceNode","id":"t","node":{"type":"text","id":"t","text":"Bye"}}]"#)
        )
        XCTAssertEqual(outcome, .applied(revision: 2))
        XCTAssertEqual(session.spec?.root.children?.first?.text, "Bye")
        XCTAssertEqual(session.structureRevision, 1)
    }

    func testRevisionIsOneCounterAcrossDeviceStateWritesAndPatches() throws {
        var session = try session()
        _ = session.change(key: "count", value: .number(2))
        XCTAssertEqual(session.dataRevision, 2)
        let (outcome, _) = try session.patch(
            id: "p", baseRevision: 2, ops: ops(#"[{"op":"replace","path":"/data/title","value":"B"}]"#)
        )
        XCTAssertEqual(outcome, .applied(revision: 3))
    }

    // MARK: Refused

    func testStateOpWithoutBaseRevisionIsRefused() throws {
        var session = try session()
        let (outcome, events) = try session.patch(
            id: "p", baseRevision: nil, ops: ops(#"[{"op":"test","path":"/state/count","value":1}]"#)
        )
        XCTAssertEqual(outcome, .rejected(message: "baseRevision is required when a patch has /state ops", revision: 1))
        XCTAssertTrue(events.isEmpty)
    }

    func testBaseRevisionNewerThanTheDeviceIsRefused() throws {
        var session = try session()
        let (outcome, _) = try session.patch(
            id: "p", baseRevision: 3, ops: ops(#"[{"op":"replace","path":"/state/count","value":9}]"#)
        )
        XCTAssertEqual(
            outcome, .rejected(message: "baseRevision 3 is newer than the device revision 1", revision: 1)
        )
        XCTAssertEqual(session.state["count"], .number(1))
    }

    func testAKeyTheUserChangedAfterBaseRevisionConflictsAndChangesNothing() throws {
        var session = try session()
        _ = session.change(key: "count", value: .number(7))
        let (outcome, events) = try session.patch(
            id: "p", baseRevision: 1,
            ops: ops(
                #"[{"op":"replace","path":"/data/title","value":"B"},{"op":"replace","path":"/state/count","value":9}]"#
            )
        )
        XCTAssertEqual(outcome, .conflict(revision: 2, state: ["count": .number(7)], baseRevision: 1))
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(session.data?["title"], .string("A"), "the data op of a conflicting patch is not applied")
        XCTAssertEqual(session.state["count"], .number(7))
    }

    func testAnUntouchedKeyDoesNotConflictWithAnotherKeysWrite() throws {
        var session = try session()
        _ = session.change(key: "count", value: .number(7))
        let (outcome, _) = try session.patch(
            id: "p", baseRevision: 1, ops: ops(#"[{"op":"replace","path":"/state/flag","value":true}]"#)
        )
        XCTAssertEqual(outcome, .applied(revision: 3))
    }

    func testAFailedOpIsAtomicAndNamesItsPath() throws {
        var session = try session()
        let (outcome, events) = try session.patch(
            id: "p", baseRevision: nil,
            ops: ops(#"[{"op":"replace","path":"/data/title","value":"B"},{"op":"remove","path":"/data/missing"}]"#)
        )
        XCTAssertEqual(outcome, .rejected(message: "ops[1].path: Path does not exist", revision: 1))
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(session.data?["title"], .string("A"))
        XCTAssertEqual(session.dataRevision, 1)
    }

    func testUnknownIdIsRefusedWithoutARevision() throws {
        var session = try session()
        let (outcome, _) = try session.patch(
            id: "other", baseRevision: nil, ops: ops(#"[{"op":"add","path":"/data/n","value":1}]"#)
        )
        XCTAssertEqual(outcome, .rejected(message: "Unknown prototype id: other", revision: nil))
    }

    func testAStateValueThatBreaksABoundControlIsRefused() throws {
        var session = try session()
        let (outcome, _) = try session.patch(
            id: "p", baseRevision: 1, ops: ops(#"[{"op":"replace","path":"/state/flag","value":"nope"}]"#)
        )
        guard case let .rejected(message, revision) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(revision, 1)
        XCTAssertEqual(session.state["flag"], .bool(false))
    }

    func testAPatchBeforeAnyShowOrAfterDismissalIsRefused() throws {
        var session = PrototypeSession()
        XCTAssertEqual(
            try session.patch(id: "p", baseRevision: nil, ops: ops("[]")).0,
            .rejected(message: "Unknown prototype id: p", revision: nil)
        )
    }

    // MARK: Wire reply

    func testReplyShapesMatchTheCtrlProxyPrototypeResult() {
        let applied = PrototypePatchOutcome.applied(revision: 4).reply
        XCTAssertTrue(applied.success)
        XCTAssertNil(applied.error)
        XCTAssertEqual(applied.extra["revision"] as? Int, 4)

        let conflict = PrototypePatchOutcome.conflict(revision: 3, state: ["count": .number(7)], baseRevision: 1).reply
        XCTAssertFalse(conflict.success)
        XCTAssertEqual(conflict.error, "conflict: state changed after baseRevision 1")
        let body = conflict.extra["conflict"] as? [String: Any]
        XCTAssertEqual(body?["revision"] as? Int, 3)
        XCTAssertEqual((body?["state"] as? [String: Any])?["count"] as? Double, 7)

        let refused = PrototypePatchOutcome.rejected(message: "boom", revision: nil).reply
        XCTAssertEqual(refused.error, "boom")
        XCTAssertTrue(refused.extra.isEmpty)
    }

    // MARK: Capability

    func testAgentAdvertisesPatchTogetherWithTheRequestItHandles() throws {
        XCTAssertEqual(PrototypeAgentProtocol.patchCapability, "prototype_patch_v1")
        XCTAssertEqual(PrototypeAgentProtocol.patchRequest, "patch_prototype")
        var gate = PrototypeConnectionGate(token: String(repeating: "t", count: 16))
        let hello = try JSONSerialization.data(withJSONObject: [
            "type": "hello",
            "token": String(repeating: "t", count: 16),
        ])
        guard case let .helloAccepted(result) = gate.receive(line: hello) else { return XCTFail("hello") }
        let capabilities = try XCTUnwrap(result["capabilities"] as? [String])
        XCTAssertTrue(capabilities.contains("prototype_patch_v1"))
        XCTAssertTrue(capabilities.contains("patch_prototype"))
    }

    // MARK: Size baseline (#13061)

    /// A session whose spec sits 150 bytes under the cap, as measured at show.
    private func nearCapSession() throws -> PrototypeSession {
        var session = PrototypeSession()
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(Self.source.utf8))
        session.show(spec, specBytes: PrototypeLimits.maxSpecBytes - 150)
        return session
    }

    func testGrowingDataRaisesTheSizeBaselineForLaterPatches() throws {
        var session = try nearCapSession()
        let grown = String(repeating: "d", count: 120)
        let (first, _) = try session.patch(
            id: "p", baseRevision: nil,
            ops: ops(#"[{"op":"replace","path":"/data/title","value":"\#(grown)"}]"#)
        )
        XCTAssertEqual(first, .applied(revision: 2))
        let text = String(repeating: "s", count: 60)
        let (second, _) = try session.patch(
            id: "p", baseRevision: 2,
            ops: ops(#"[{"op":"replace","path":"/state/count","value":"\#(text)"}]"#)
        )
        guard case let .rejected(message, _) = second else { return XCTFail("expected a refusal, got \(second)") }
        XCTAssertEqual(message, "Spec byte limit exceeded")
        XCTAssertEqual(session.state["count"], .number(1))
    }

    func testShrinkingDataLowersTheSizeBaselineForLaterPatches() throws {
        var session = try nearCapSession()
        let (first, _) = try session.patch(
            id: "p", baseRevision: nil, ops: ops(#"[{"op":"remove","path":"/data/items"}]"#)
        )
        XCTAssertEqual(first, .applied(revision: 2))
        let text = String(repeating: "s", count: 140)
        let (second, _) = try session.patch(
            id: "p", baseRevision: 2,
            ops: ops(#"[{"op":"replace","path":"/state/count","value":"\#(text)"}]"#)
        )
        XCTAssertEqual(second, .applied(revision: 3))
    }

    // MARK: Size baseline after a data write

    private func dataWrite(_ json: String) throws -> [PrototypeAction] {
        try JSONDecoder().decode([PrototypeAction].self, from: Data(json.utf8))
    }

    /// A `setData` action grows the spec like a patch does, so a later patch is measured against it.
    func testGrowingDataByAnActionRaisesTheSizeBaselineForLaterPatches() throws {
        var session = try nearCapSession()
        let grown = String(repeating: "d", count: 120)
        let events = try session
            .run(dataWrite(#"[{"type":"setData","path":"/data/title","value":{"value":"\#(grown)"}}]"#))
        XCTAssertEqual(events.count, 1)
        let text = String(repeating: "s", count: 60)
        let (second, _) = try session.patch(
            id: "p", baseRevision: 2,
            ops: ops(#"[{"op":"replace","path":"/state/count","value":"\#(text)"}]"#)
        )
        guard case let .rejected(message, _) = second else { return XCTFail("expected a refusal, got \(second)") }
        XCTAssertEqual(message, "Spec byte limit exceeded")
    }

    func testShrinkingDataByAnActionLowersTheSizeBaselineForLaterPatches() throws {
        var session = try nearCapSession()
        let events = try session.run(dataWrite(#"[{"type":"removeData","path":"/data/items"}]"#))
        XCTAssertEqual(events.count, 1)
        let text = String(repeating: "s", count: 155)
        let (second, _) = try session.patch(
            id: "p", baseRevision: 2,
            ops: ops(#"[{"op":"replace","path":"/state/count","value":"\#(text)"}]"#)
        )
        XCTAssertEqual(second, .applied(revision: 3))
    }
}
