@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeLazyListRuntimeTests: XCTestCase {
    private func spec(_ fixture: String = "list-paging", maxItems: Int? = nil) throws -> PrototypeSpec {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let bytes = try Data(contentsOf: repository.appendingPathComponent(
            "test/fixtures/prototype-spec/valid/\(fixture).json"
        ))
        var raw = try JSONDecoder().decode(JSONValue.self, from: bytes).objectFields ?? [:]
        if let maxItems {
            var root = raw["root"]?.objectFields ?? [:]
            root["maxItems"] = .number(Double(maxItems))
            raw["root"] = .object(root)
        }
        return try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(JSONValue.object(raw)))
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }

    private func item(_ id: Int) -> JSONValue {
        .object(["id": .number(Double(id)), "title": .string("Row \(id)")])
    }

    func testFixtureRowsAndHeaderFooterRemainSeparate() throws {
        for name in ["list-basic", "list-header-footer", "list-paging"] {
            let spec = try spec(name)
            let rows = try PrototypeLazyList.rows(node: spec.root, data: spec.data)
            XCTAssertEqual(rows.map(\.key), ["1", "2"])
            XCTAssertEqual(rows.map(\.node.text), name == "list-paging" ? ["0: One", "1: Two"] : ["One", "Two"])
            XCTAssertEqual(spec.root.children?.count, 1)
            XCTAssertEqual(spec.root.nodePath, "root")
            if name == "list-header-footer" {
                XCTAssertEqual(spec.root.header?.text, "Feed p2")
                XCTAssertEqual(spec.root.footer?.text, "End")
            }
        }
        XCTAssertEqual(prototypeAccessibilityGrouping(type: "list", tappable: true), .contain)
    }

    func testDriverWaitsForAppearanceAndDeduplicatesContentChanges() {
        var driver = PrototypeListEndDriver(endThreshold: 2)
        XCTAssertFalse(driver.update(appearedIndex: nil, rowKeys: ["1", "2"]))
        XCTAssertFalse(driver.update(appearedIndex: 0, rowKeys: []))
        XCTAssertTrue(driver.update(appearedIndex: 1, rowKeys: ["1", "2"]))
        XCTAssertFalse(driver.update(appearedIndex: 0, rowKeys: ["1", "2"]))
        XCTAssertTrue(driver.update(appearedIndex: nil, rowKeys: ["2", "3"]))
        XCTAssertFalse(driver.update(appearedIndex: nil, rowKeys: ["2", "3"]))
        XCTAssertFalse(driver.update(appearedIndex: nil, rowKeys: ["1", "2", "3", "4", "5"]))
        XCTAssertTrue(driver.update(appearedIndex: 4, rowKeys: ["1", "2", "3", "4", "5"]))
    }

    func testSessionTriggerSurvivesRebuildAndResetsOnShow() throws {
        let spec = try spec(maxItems: 2)
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertFalse(session.listVisible(spec.root, appearedIndex: 1).isEmpty)
        XCTAssertTrue(session.listVisible(spec.root, appearedIndex: 1).isEmpty)
        _ = try session
            .run(
                [
                    action(
                        #"{"type":"appendData","path":"/data/feed/items","value":{"value":{"id":3,"title":"Three"}}}"#
                    ),
                ]
            )
        let rebuilt = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(rebuilt.nodePath, spec.root.nodePath)
        XCTAssertFalse(session.listVisible(rebuilt).isEmpty)
        XCTAssertTrue(session.listVisible(rebuilt).isEmpty)
        session.show(spec)
        XCTAssertFalse(session.listVisible(spec.root, appearedIndex: 1).isEmpty)
    }

    func testAppendDataTrimsInOneReplayableEvent() throws {
        var session = PrototypeSession()
        try session.show(spec(maxItems: 2))
        let events = try session
            .run(
                [
                    action(
                        #"{"type":"appendData","path":"/data/feed/items","value":{"value":{"id":3,"title":"Three"}}}"#
                    ),
                ]
            )
        XCTAssertEqual(events.count, 1)
        let event = try XCTUnwrap(events.first)
        let write = try XCTUnwrap(PrototypeDataWriteEvent.decode(
            kind: event.wireKind,
            name: event.name,
            payload: event.payload
        ))
        XCTAssertEqual(write.op, .append)
        XCTAssertEqual(write.maxItems, 2)
        XCTAssertEqual(write.revision, 2)
        let root = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(try PrototypeLazyList.rows(node: root, data: session.data).map(\.key), ["2", "3"])
    }

    func testResponseUsesLatestDataThenCommitsAppendIntoMetaStatusAndFollowup() throws {
        let spec = try spec(maxItems: 2)
        var session = PrototypeSession()
        session.show(spec)
        _ = try session.run(XCTUnwrap(spec.root.onEndReached))
        // Response is available, but a host write wins the main-actor turn before completion.
        let response = PrototypeRequestResponse.received(status: 200, headers: [:], body: .object([
            "items": .array([item(4)]), "next": .string("p3"),
        ]), durationMs: 1)
        _ = try session
            .run(
                [
                    action(
                        #"{"type":"setData","path":"/data/feed/items","value":{"value":[{"id":3,"title":"Three"}]}}"#
                    ),
                ]
            )
        let before = session.dataRevision
        let events = session.completeRequest("r-1", response)
        XCTAssertEqual(
            events.map(\.name),
            ["/data/feed/items", "/data/page", "/data/page__meta", "change", "prototype_request"]
        )
        let writes = events.compactMap { event in
            PrototypeDataWriteEvent.decode(kind: event.wireKind, name: event.name, payload: event.payload)
        }
        XCTAssertEqual(writes.map(\.op), [.extend, .set, .set])
        XCTAssertEqual(writes.map(\.revision), [before + 1, before + 2, before + 3])
        XCTAssertEqual(writes.first?.value, .array([item(4)]))
        XCTAssertEqual(writes.first?.maxItems, 2)
        XCTAssertEqual(session.dataRevision, before + 4)
        let root = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(try PrototypeLazyList.rows(node: root, data: session.data).map(\.key), ["3", "4"])
        XCTAssertEqual(session.data?["page"], .object(["next": .string("p3")]))
        XCTAssertEqual(session.state["feedStatus"], .string("success"))
    }

    func testInvalidResponseAndRenderFailureRollBackAppend() throws {
        for items in [JSONValue.string("bad"), .array([item(2)])] {
            let spec = try spec()
            var session = PrototypeSession()
            session.show(spec)
            _ = try session.run(XCTUnwrap(spec.root.onEndReached))
            let before = session.data
            let events = session.completeRequest("r-1", .received(status: 200, headers: [:], body: .object([
                "items": items, "next": .string("p3"),
            ]), durationMs: 1))
            XCTAssertEqual(session.data?["feed"], before?["feed"])
            XCTAssertEqual(session.data?["page"], before?["page"])
            XCTAssertFalse(events.contains { $0.name == "/data/feed/items" || $0.name == "/data/page" })
            XCTAssertEqual(session.state["feedStatus"], .string("error"))
        }
    }

    func testAppendWithoutIntoRunsFollowupsAfterRequestEvent() throws {
        for success in [true, false] {
            var session = PrototypeSession()
            try session.show(spec())
            let request =
                try action(
                    #"{"type":"request","url":"http://localhost/feed","append":{"from":"/items","to":"/data/feed/items"},"onSuccess":[{"type":"emit","name":"loaded"}],"onError":[{"type":"emit","name":"failed"}]}"#
                )
            _ = session.run([request])
            let events = session.completeRequest("r-1", .received(status: 200, headers: [:], body: .object([
                "items": success ? .array([item(3)]) : .string("bad"),
            ]), durationMs: 1))
            XCTAssertEqual(
                events.map(\.name),
                success
                    ? ["/data/feed/items", "prototype_request", "loaded"] : ["prototype_request", "failed"]
            )
        }
    }

    func testTwoListsRetainIndependentPathTriggersAndUseSmallestWindow() throws {
        let base = try spec()
        let rawList = base.authoredRoot.objectFields ?? [:]
        var other = rawList
        other["id"] = .string("other")
        other["maxItems"] = .number(2)
        let root = JSONValue.object(["type": .string("column"), "children": .array([
            .object(rawList), .object(other),
        ])])
        let raw = JSONValue.object([
            "id": .string("two"), "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "data": .object(base.data ?? [:]), "state": .object(base.state ?? [:]), "root": root,
        ])
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(raw))
        XCTAssertEqual(PrototypeLazyList.listMaxItems(spec: decoded, dataPath: "/data/feed/items"), 2)
        let lists = try XCTUnwrap(decoded.root.children)
        XCTAssertNotEqual(lists[0].nodePath, lists[1].nodePath)
        var session = PrototypeSession()
        session.show(decoded)
        XCTAssertFalse(session.listVisible(lists[0], appearedIndex: 1).isEmpty)
        XCTAssertFalse(session.listVisible(lists[1], appearedIndex: 1).isEmpty)
        XCTAssertTrue(session.listVisible(lists[0], appearedIndex: 1).isEmpty)
    }

    func testListRefreshWritesFlagBeforeRunningActions() throws {
        let spec = try spec()
        var session = PrototypeSession()
        session.show(spec)
        _ = try session.run(PrototypeRefresh.actions(for: XCTUnwrap(spec.root.refresh)))
        XCTAssertEqual(session.state["refreshing"], .bool(true))
        XCTAssertEqual(session.requests.inFlight.count, 1)
        _ = session.completeRequest("r-1", .received(status: 200, headers: [:], body: .object([
            "items": .array([item(5)]),
        ]), durationMs: 1))
        XCTAssertEqual(session.state["refreshing"], .bool(false))
    }
}
