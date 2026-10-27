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
            if root["onEndReached"] != nil { root["endThreshold"] = .number(1) }
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

    func testDriverRecomputesVisibleIndicesAfterTrimAndRefresh() {
        var driver = PrototypeListEndDriver(endThreshold: 3)
        let original = (0 ..< 100).map(String.init)
        XCTAssertTrue(driver.update(appearedKey: "99", rowKeys: original))
        XCTAssertFalse(driver.update(appearedKey: nil, rowKeys: (20 ..< 120).map(String.init)))
        XCTAssertFalse(driver.update(appearedKey: nil, rowKeys: (200 ..< 220).map(String.init)))
    }

    func testFittingListFiresOnceAndAgainAfterAppendAndReappearance() {
        var driver = PrototypeListEndDriver(endThreshold: 3)
        XCTAssertFalse(driver.update(rowKeys: []))
        XCTAssertFalse(driver.update(rowKeys: ["1", "2"]))
        XCTAssertTrue(driver.update(appearedKey: "1", rowKeys: ["1", "2"]))
        XCTAssertFalse(driver.update(appearedKey: "2", rowKeys: ["1", "2"]))
        XCTAssertTrue(driver.update(rowKeys: ["1", "2", "3"]))
        XCTAssertFalse(driver.update(disappearedKey: "1", rowKeys: ["1", "2", "3"]))
        XCTAssertFalse(driver.update(disappearedKey: "2", rowKeys: ["1", "2", "3"]))
        XCTAssertFalse(driver.update(rowKeys: ["1", "2", "3", "4"]))
        XCTAssertTrue(driver.update(appearedKey: "2", rowKeys: ["1", "2", "3", "4"]))
        XCTAssertFalse(driver.update(disappearedKey: "2", rowKeys: ["1", "2", "3", "4"]))
        XCTAssertFalse(driver.update(appearedKey: "2", rowKeys: ["1", "2", "3", "4"]))
    }

    func testKeysMatchBoundRowsBeforeAndAfterTrimming() throws {
        for fixture in ["list-basic", "list-paging"] {
            let spec = try spec(fixture, maxItems: 2)
            var session = PrototypeSession()
            session.show(spec)
            for trimmed in [false, true] {
                if trimmed {
                    _ = try session
                        .run(
                            [
                                action(
                                    #"{"type":"appendData","path":"/data/feed/items","value":{"value":{"id":3,"title":"Three"}}}"#
                                ),
                            ]
                        )
                }
                let root = try XCTUnwrap(session.spec?.root)
                XCTAssertEqual(
                    PrototypeLazyList.keys(node: root, data: session.data),
                    try PrototypeLazyList.rows(node: root, data: session.data).map(\.key)
                )
                XCTAssertEqual(
                    PrototypeLazyList.keys(node: root, data: session.data),
                    trimmed ? ["2", "3"] : ["1", "2"]
                )
            }
        }
    }

    func testFailedRowIsAbsentAndWarnsOnceWhileOtherRowsStillDecode() throws {
        struct DecodeFailure: Error {}
        let spec = try spec()
        var warnings: [String] = []
        var boundIndices: [Int] = []
        let decoder = PrototypeLazyList.RowDecoder(warning: { warnings.append($0) }, load: { node, data, index in
            boundIndices.append(index)
            if index == 0 { throw DecodeFailure() }
            return try PrototypeLazyList.row(node: node, data: data, index: index)
        })
        XCTAssertEqual(PrototypeLazyList.keys(node: spec.root, data: spec.data), ["1", "2"])
        XCTAssertTrue(boundIndices.isEmpty)
        XCTAssertNil(decoder.decode(node: spec.root, data: spec.data, index: 0))
        XCTAssertNil(decoder.decode(node: spec.root, data: spec.data, index: 0))
        XCTAssertEqual(decoder.decode(node: spec.root, data: spec.data, index: 1)?.node.text, "1: Two")
        XCTAssertEqual(boundIndices, [0, 0, 1])
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings[0].contains("Could not decode lazy list row at root[0]"))
    }

    func testMetadataRendererRefusalPreservesNoRoomCause() throws {
        let original = try spec()
        var root = original.authoredRoot.objectFields ?? [:]
        root["footer"] =
            .object([
                "type": .string("text"),
                "text": .string("{data:/padding}{data:/page__meta/status}"),
            ])
        var data = original.data ?? [:]
        data["padding"] = .string(String(repeating: "x", count: PrototypeLimits.maxSubstitutedTextLength - 1))
        let raw: JSONValue = .object([
            "id": .string("meta"), "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "data": .object(data), "state": .object(original.state ?? [:]), "root": .object(root),
        ])
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(raw)))
        _ = try session.run(XCTUnwrap(session.spec?.root.onEndReached))
        let before = session.data
        let events = session.completeRequest("r-1", .received(status: 200, headers: [:], body: .object([
            "items": .array([item(3)]), "next": .string("p3"),
        ]), durationMs: 1))
        let payload = try XCTUnwrap(events.first { $0.name == "prototype_request" }?.payload.objectFields)
        XCTAssertEqual(payload["error"]?.objectFields?["message"], .string(PrototypeRequestOutcome.noRoomForMeta))
        XCTAssertEqual(session.data?["feed"], before?["feed"])
        XCTAssertEqual(session.data?["page"], before?["page"])
    }

    func testOverlappingRequestTargetsCancelWithoutWritesOrFollowups() throws {
        let page =
            try action(
                #"{"type":"request","url":"http://localhost/page","append":{"from":"/items","to":"/data/feed/items"},"onSuccess":[{"type":"emit","name":"stale-success"}],"onError":[{"type":"emit","name":"stale-error"}]}"#
            )
        let refresh =
            try action(
                #"{"type":"request","url":"http://localhost/refresh","into":"/data/feed","onSuccess":[{"type":"emit","name":"stale-success"}],"onError":[{"type":"emit","name":"stale-error"}]}"#
            )
        for pair in [[page, refresh], [refresh, page], [page, page]] {
            var session = PrototypeSession()
            try session.show(spec())
            _ = session.run([pair[0]])
            _ = session.takeRequestCommands()
            let before = session.data
            let events = session.run([pair[1]])
            XCTAssertEqual(
                session.takeRequestCommands(),
                try [.cancel(requestId: "r-1"), .start(XCTUnwrap(session.requests.inFlight["r-2"]).job)]
            )
            XCTAssertEqual(events.map(\.name), ["prototype_request"])
            XCTAssertEqual(events.first?.payload.objectFields?["error"]?.objectFields?["code"], .string("cancelled"))
            XCTAssertTrue(session.completeRequest(
                "r-1",
                .received(status: 200, headers: [:], body: .object(["items": .array([item(3)])]), durationMs: 1)
            ).isEmpty)
            XCTAssertEqual(session.data, before)
        }
    }

    func testSessionTriggerSurvivesRebuildAndResetsOnShow() throws {
        let spec = try spec(maxItems: 2)
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertFalse(session.listVisible(spec.root, appearedKey: "2").isEmpty)
        XCTAssertTrue(session.listVisible(spec.root, appearedKey: "2").isEmpty)
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
        XCTAssertTrue(session.listVisible(rebuilt).isEmpty)
        XCTAssertFalse(session.listVisible(rebuilt, appearedKey: "3").isEmpty)
        XCTAssertTrue(session.listVisible(rebuilt).isEmpty)
        session.show(spec)
        XCTAssertFalse(session.listVisible(spec.root, appearedKey: "2").isEmpty)
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

    func testAppendRendererRefusalPreservesCause() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run(XCTUnwrap(session.spec?.root.onEndReached))
        let events = session.completeRequest("r-1", .received(status: 200, headers: [:], body: .object([
            "items": .array([item(2)]), "next": .string("p3"),
        ]), durationMs: 1))
        let payload = try XCTUnwrap(events.first { $0.name == "prototype_request" }?.payload.objectFields)
        XCTAssertEqual(
            payload["error"]?.objectFields?["message"],
            .string("append.to /data/feed/items: the changed data breaks a limit the show enforces")
        )
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
        other["endThreshold"] = .number(1)
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
        XCTAssertFalse(session.listVisible(lists[0], appearedKey: "2").isEmpty)
        XCTAssertFalse(session.listVisible(lists[1], appearedKey: "2").isEmpty)
        XCTAssertTrue(session.listVisible(lists[0], appearedKey: "2").isEmpty)
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
