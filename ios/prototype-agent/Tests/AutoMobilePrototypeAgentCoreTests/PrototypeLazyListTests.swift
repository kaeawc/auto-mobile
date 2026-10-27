@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeLazyListTests: XCTestCase {
    func testAnchorSurvivesPrependIncludingAtTopAndReorder() {
        XCTAssertEqual(PrototypeListAnchor.resolve(anchorKey: "a", newKeys: ["new", "a", "b"]), "a")
        XCTAssertEqual(PrototypeListAnchor.resolve(anchorKey: "b", newKeys: ["b", "a"]), "b")
        XCTAssertNil(PrototypeListAnchor.resolve(anchorKey: "gone", newKeys: ["a"]))
        XCTAssertNil(PrototypeListAnchor.resolve(anchorKey: "a", newKeys: []))
        XCTAssertNil(PrototypeListAnchor.resolve(anchorKey: nil, newKeys: ["a"]))
    }

    func testStackAnchorsAreIndependentRetainedWhileCoveredAndClearedOnPop() {
        var store = PrototypeStackListAnchorStore()
        store.retain(entryIDs: [1, 2])
        store.save(entryID: 1, listPath: "root.a", key: "a")
        store.save(entryID: 1, listPath: "root.b", key: "b")
        store.save(entryID: 2, listPath: "root.a", key: "c")
        XCTAssertEqual(store.read(entryID: 1, listPath: "root.a", newKeys: ["a", "c"]), "a")
        XCTAssertEqual(store.read(entryID: 1, listPath: "root.b", newKeys: ["b"]), "b")
        XCTAssertEqual(store.read(entryID: 2, listPath: "root.a", newKeys: ["a", "c"]), "c")
        store.retain(entryIDs: [1])
        // An exiting view cannot resurrect a popped entry's state.
        store.save(entryID: 2, listPath: "root.a", key: "c")
        store.retain(entryIDs: [1, 2])
        XCTAssertNil(store.read(entryID: 2, listPath: "root.a", newKeys: ["c"]))
        XCTAssertEqual(store.read(entryID: 1, listPath: "root.a", newKeys: ["a"]), "a")
        store.retain(entryIDs: [])
        store.retain(entryIDs: [1])
        XCTAssertNil(store.read(entryID: 1, listPath: "root.a", newKeys: ["a"]))
    }

    func testMissingSavedRowFallsBackToTopAndDoesNotResurrect() {
        var store = PrototypeStackListAnchorStore()
        store.retain(entryIDs: [1])
        store.save(entryID: 1, listPath: "list", key: "old")
        XCTAssertNil(store.read(entryID: 1, listPath: "list", newKeys: ["new"]))
        XCTAssertNil(store.read(entryID: 1, listPath: "list", newKeys: ["old", "new"]))
        store.save(entryID: 1, listPath: "list", key: "new")
        store.save(entryID: 1, listPath: "list", key: nil)
        XCTAssertNil(store.read(entryID: 1, listPath: "list", newKeys: ["new"]))
    }

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func read(_ path: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: fixtures.appendingPathComponent(path)))
    }

    func testSharedDataWrites() throws {
        for raw in try PrototypeStrictBindings.array(read("list-writes/data-writes.json")) {
            let fixture = try XCTUnwrap(raw.objectFields)
            let write = try XCTUnwrap(fixture["write"]?.objectFields)
            let expected = try XCTUnwrap(fixture["expected"]?.objectFields)
            let name = fixture["name"]?.stringValue ?? ""
            let op = try XCTUnwrap(PrototypeDataWrite.Operation(rawValue: write["op"]?.stringValue ?? ""))
            let result = PrototypeDataWrite.applyWindowed(
                fixture["before"]?.objectFields,
                op: op,
                path: write["path"]?.stringValue ?? "",
                value: write["value"],
                maxItems: write["maxItems"]?.numberValue, key: write["key"]?.stringValue
            )
            switch result {
            case let .success(applied):
                XCTAssertEqual(JSONValue.object(applied.data), expected["data"], name)
                XCTAssertEqual(applied.trimmed, expected["trimmed"]?.intValue, name)
            case let .failure(error): XCTAssertEqual(error.code.rawValue, expected["errorCode"]?.stringValue, name)
            }
        }
    }

    func testSharedRequestOutcomes() throws {
        for raw in try PrototypeStrictBindings.array(read("list-writes/request-outcomes.json")) {
            let fixture = try XCTUnwrap(raw.objectFields)
            let expected = try XCTUnwrap(fixture["expected"]?.objectFields)
            let responseValue = try XCTUnwrap(fixture["response"])
            let response = try XCTUnwrap(
                PrototypeRequestWire
                    .decodeResponse(responseValue.foundationObject as? [String: Any] ?? [:])
            )
            let append = try fixture["append"]
                .map { try JSONDecoder().decode(PrototypeRequestAppend.self, from: JSONEncoder().encode($0)) }
            let result = PrototypeRequestOutcome.apply(
                fixture["before"]?.objectFields ?? [:],
                into: fixture["into"]?.stringValue,
                response: response.response,
                append: append
            )
            let name = fixture["name"]?.stringValue ?? ""
            XCTAssertEqual(result.status, expected["status"]?.stringValue, name)
            XCTAssertEqual(.object(result.data), expected["data"], name)
            XCTAssertEqual(result.meta.json(), expected["meta"], name)
            XCTAssertEqual(result.wroteInto, expected["wroteInto"]?.boolValue, name)
            XCTAssertEqual(result.appended, expected["appended"]?.intValue, name)
        }
    }

    private func assertFixture(_ name: String) throws {
        let fixture = try read("invalid/" + name).objectFields ?? [:]
        let data = try JSONEncoder().encode(XCTUnwrap(fixture["spec"]))
        let options = fixture["options"]?.objectFields
        let capabilities = options?["supportedCapabilities"].map { Set(PrototypeContractValidator.strings($0)) }
        XCTAssertThrowsError(
            try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: capabilities),
            name
        ) { error in
            XCTAssertEqual(
                error as? PrototypeLoadError,
                .invalidSpec(
                    path: fixture["expectedPath"]?.stringValue ?? "",
                    message: fixture["expectedMessage"]?.stringValue ?? ""
                ),
                name
            )
        }
    }

    func testListDuplicateKey() throws { try assertFixture("list-duplicate-key.json") }
    func testListHorizontalRefresh() throws { try assertFixture("list-horizontal-refresh.json") }
    func testListInList() throws { try assertFixture("list-in-list.json") }
    func testListInRepeat() throws { try assertFixture("list-in-repeat.json") }
    func testListInSameAxisScroll() throws { try assertFixture("list-in-same-axis-scroll.json") }
    func testListItemsExceedMaxItems() throws { try assertFixture("list-items-exceed-maxItems.json") }
    func testListLiteralItems() throws { try assertFixture("list-literal-items.json") }
    func testListMissingKey() throws { try assertFixture("list-missing-key.json") }
    func testListRefreshUndeclared() throws { try assertFixture("list-refresh-undeclared.json") }
    func testListRepeatInRow() throws { try assertFixture("list-repeat-in-row.json") }
    func testListSameAxisScroll() throws { try assertFixture("list-same-axis-scroll.json") }
    func testListThresholdWithoutAction() throws { try assertFixture("list-threshold-without-action.json") }
    func testListTwoChildren() throws { try assertFixture("list-two-children.json") }
    func testListUnknownKey() throws { try assertFixture("list-unknown-key.json") }
    func testRequestAppendToNonArray() throws { try assertFixture("request-append-to-non-array.json") }
    func testRequestAppendToOverlap() throws { try assertFixture("request-append-to-overlap.json") }
    func testRequestAppendToPath() throws { try assertFixture("request-append-to-path.json") }
    func testStrictBound024NodeListChildrenPlusOne() throws {
        try assertFixture("strict-bound-024-node-list-children-plus-one.json")
    }

    func testStrictBound026NodeListEndThresholdPlusOne() throws {
        try assertFixture("strict-bound-026-node-list-endThreshold-plus-one.json")
    }

    func testStrictBound027NodeListMaxItemsPlusOne() throws {
        try assertFixture("strict-bound-027-node-list-maxItems-plus-one.json")
    }

    func testStrictGatePrototypeLazyListV1() throws { try assertFixture("strict-gate-prototype_lazy_list_v1.json") }

    func testLazyRowsPreserveKeysAndBindingsBeyondRepeatLimit() throws {
        var spec = try read("valid/list-basic.json").objectFields ?? [:]
        var data = spec["data"]?.objectFields ?? [:]
        data["feed"] =
            .object(["items": .array((0 ..< 200)
                        .map { .object(["id": .number(Double($0)), "title": .string("Row \($0)")]) })])
        spec["data"] = .object(data)
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(JSONValue.object(spec)))
        XCTAssertEqual(decoded.root.children?.count, 1)
        let rows = try PrototypeLazyList.rows(node: decoded.root, data: decoded.data)
        XCTAssertEqual(rows.count, 200)
        XCTAssertEqual(rows.last?.key, "199")
        XCTAssertEqual(rows.last?.node.text, "Row 199")
    }

    func testSmallestWindowAndEndSignature() throws {
        let root: JSONValue = .object(["type": .string("column"), "children": .array([100, 20].map { count in
            .object([
                "type": .string("list"),
                "maxItems": .number(Double(count)),
                "repeat": .object(["items": .object(["path": .string("/items")])]),
            ])
        })])
        XCTAssertEqual(PrototypeLazyList.listMaxItems(root: root, dataPath: "/data/items"), 20)
        XCTAssertNil(PrototypeLazyList.listMaxItems(root: root, dataPath: "/data/other"))
        var trigger = PrototypeListEndTrigger(endThreshold: 2)
        XCTAssertFalse(trigger.onVisibleRange(lastVisibleIndex: 0, rowCount: 0, lastRowKey: nil))
        XCTAssertFalse(trigger.onVisibleRange(lastVisibleIndex: 0, rowCount: 4, lastRowKey: "4"))
        XCTAssertTrue(trigger.onVisibleRange(lastVisibleIndex: 2, rowCount: 4, lastRowKey: "4"))
        XCTAssertFalse(trigger.onVisibleRange(lastVisibleIndex: 3, rowCount: 4, lastRowKey: "4"))
        XCTAssertTrue(trigger.onVisibleRange(lastVisibleIndex: 3, rowCount: 4, lastRowKey: "5"))
        XCTAssertTrue(trigger.onVisibleRange(lastVisibleIndex: 4, rowCount: 5, lastRowKey: "5"))
    }

    func testWindowedEventRoundtripAndGuards() throws {
        let event = PrototypeDataWriteEvent(
            op: .extend,
            path: "/data/items",
            value: .array([.number(1)]),
            maxItems: 2,
            revision: 3
        )
        XCTAssertEqual(PrototypeDataWriteEvent.decode(kind: "change", name: event.path, payload: event.payload), event)
        var fields = event.payload.objectFields ?? [:]
        for invalid in [JSONValue.number(1.5), .number(0), .number(9_007_199_254_740_992)] {
            fields["maxItems"] = invalid
            XCTAssertNil(PrototypeDataWriteEvent.decode(kind: "change", name: event.path, payload: .object(fields)))
        }
        fields["maxItems"] = .number(2)
        fields["value"] = .string("bad")
        XCTAssertNil(PrototypeDataWriteEvent.decode(kind: "change", name: event.path, payload: .object(fields)))
    }

    func testTemplateCountIsIndependentOfRowCount() throws {
        var spec = try read("valid/list-basic.json").objectFields ?? [:]
        var node = spec["root"]?.objectFields ?? [:]
        node["children"] = .array([.object(["type": .string("column"), "children": .array((0 ..< 5).map { _ in
            .object(["type": .string("image"), "asset": .string("picture")])
        })])])
        spec["root"] = .object(node)
        let items = (0 ..< PrototypeLimits.maxListItems).map { JSONValue.object(["id": .number(Double($0))]) }
        spec["data"] = .object(["feed": .object(["items": .array(items)])])
        // Five images and seven nodes, even at the list item limit (eager expansion would exceed both limits).
        var repeats = PrototypeStrictRepeats(data: spec["data"]?.objectFields)
        try repeats.templates(node, path: "root")
        try repeats.expanded(node, path: "root")
        XCTAssertEqual(repeats.nodes, 7)
        XCTAssertEqual(repeats.images, 5)
        let raw = JSONValue.object(node)
        XCTAssertNoThrow(try PrototypeLimits.guardAuthoredTree(raw))
        XCTAssertNoThrow(try PrototypeLimits.guardTree(PrototypeDataResolver.resolveRoot(
            raw,
            data: spec["data"]?.objectFields
        )))
    }

    func testRowsBindRequestAppendAndDataConditions() throws {
        var spec = try read("valid/list-basic.json").objectFields ?? [:]
        var node = spec["root"]?.objectFields ?? [:]
        node["children"] = .array([.object([
            "type": .string("button"), "label": .string("{post.title} {data:/page/next}"),
            "visibleWhen": .object(["data": .string("/page/next"), "equals": .string("p2")]),
            "onTap": .array([.object(["type": .string("request"), "url": .string("http://localhost/"),
                                      "append": .object(["from": .string("/items"),
                                                         "to": .string("/data/groups/{index}/items")])])]),
        ])])
        spec["root"] = .object(node)
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(JSONValue.object(spec)))
        let rows = try PrototypeLazyList.rows(node: decoded.root, data: decoded.data)
        XCTAssertEqual(rows[1].node.label, "Two p2")
        XCTAssertTrue(rows[1].node.visibleWhen?.holds([:]) == true)
        XCTAssertEqual(rows[1].node.onTap?.first?.append?.to, "/data/groups/1/items")
    }

    func testHeaderBindingsAndNestedListRules() throws {
        var spec = try read("valid/list-basic.json").objectFields ?? [:]
        var node = spec["root"]?.objectFields ?? [:]
        node["header"] = .object(["type": .string("text"), "text": .string("Page {data:/page/next}")])
        spec["root"] = .object(node)
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(JSONValue.object(spec)))
        XCTAssertEqual(decoded.root.header?.text, "Page p2")
        node["footer"] = .object(["type": .string("column"), "children": .array([spec["root"] ?? .null])])
        XCTAssertThrowsError(try PrototypeLazyList.validate(
            root: .object(node),
            data: spec["data"]?.objectFields,
            state: [:]
        )) { error in
            XCTAssertEqual(
                error as? PrototypeLoadError,
                .invalidSpec(path: "root.footer.children[0]", message: "A list cannot sit inside another list")
            )
        }
    }

    func testFinalDataLimitsApplyAfterTrimming() throws {
        let applied = try PrototypeDataWrite.applyWindowed(
            ["items": .array([.number(1)])],
            op: .extend,
            path: "/data/items",
            value: .array([.null, .number(2)]),
            maxItems: 1
        ).get()
        XCTAssertEqual(applied.data, ["items": .array([.number(2)])])
        XCTAssertEqual(applied.trimmed, 2)
        let empty = try PrototypeDataWrite.applyWindowed(
            ["items": .array([.number(1), .number(2)])],
            op: .extend,
            path: "/data/items",
            value: .array([]),
            maxItems: 1
        ).get()
        XCTAssertEqual(empty.trimmed, 1)
        XCTAssertThrowsError(try PrototypeDataWrite.applyWindowed(
            ["items": .array([])],
            op: .extend,
            path: "/data/items",
            value: .array([.null]),
            maxItems: 1
        ).get())
    }

    func testMetadataFailureRollsBackAppendAndInto() {
        let data: [String: JSONValue] = ["items": .array([.number(1)]), "page": .object([:])]
        let staged: JSONValue = .object([
            "items": .array([.number(1), .number(2)]),
            "page": .object(["padding": .string("")]),
        ])
        let count = PrototypeLimits.maxDataWriteBytes - PrototypeLimits.dataByteCost(staged, depth: 0)
        let body: JSONValue = .object([
            "items": .array([.number(2)]),
            "padding": .string(String(repeating: "x", count: count)),
        ])
        let result = PrototypeRequestOutcome.apply(
            data,
            into: "/data/page",
            response: .received(status: 200, headers: [:], body: body, durationMs: 1),
            append: .init(from: "/items", to: "/data/items")
        )
        XCTAssertEqual(result.status, "error")
        XCTAssertEqual(result.data["items"], data["items"])
        XCTAssertEqual(result.data["page"], data["page"])
        XCTAssertEqual(result.appended, 0)
        XCTAssertFalse(result.wroteInto)
        XCTAssertEqual(result.meta.error?.message, PrototypeRequestOutcome.noRoomForMeta)
    }
}
