@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The agent-side backstop for the structural limits (#11049): a spec that skips the host
/// validator is still refused, on the same shared boundary fixtures TypeScript and Kotlin use.
final class PrototypeLimitsTests: XCTestCase {
    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func data(_ path: String) throws -> Data {
        try Data(contentsOf: fixtureRoot.appendingPathComponent(path))
    }

    private func rejection(_ spec: Data) -> String? {
        do {
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: spec)
            return nil
        } catch let DecodingError.dataCorrupted(context) {
            return context.debugDescription
        } catch {
            return "\(error)"
        }
    }

    func testConstantsMatchTheSharedContract() throws {
        let contract = try JSONSerialization.jsonObject(
            with: Data(
                contentsOf: fixtureRoot.deletingLastPathComponent().deletingLastPathComponent()
                    .deletingLastPathComponent().appendingPathComponent("schemas/prototype-spec-contract.json")
            )
        ) as? [String: Any]
        let limits = try XCTUnwrap(contract?["limits"] as? [String: Int])
        XCTAssertEqual(PrototypeLimits.maxStackScreens, limits["MAX_PROTOTYPE_STACK_SCREENS"])
        XCTAssertEqual(PrototypeLimits.maxStackDepth, limits["MAX_PROTOTYPE_STACK_DEPTH"])
        XCTAssertEqual(PrototypeLimits.maxPatchOps, limits["MAX_PROTOTYPE_PATCH_OPS"])
        XCTAssertEqual(PrototypeLimits.maxNodes, limits["MAX_PROTOTYPE_NODES"])
        XCTAssertEqual(PrototypeLimits.maxDepth, limits["MAX_PROTOTYPE_DEPTH"])
        XCTAssertEqual(PrototypeLimits.maxSpecBytes, limits["MAX_PROTOTYPE_SPEC_BYTES"])
        let definitions = try XCTUnwrap(contract?["definitions"] as? [String: Any])
        let repeatFields = try XCTUnwrap((definitions["repeat"] as? [String: Any])?["fields"] as? [String: Any])
        let items = try XCTUnwrap((repeatFields["items"] as? [String: Any])?["rule"] as? [String: Any])
        let options = try XCTUnwrap(items["options"] as? [[String: Any]])
        let literal = try XCTUnwrap(options.first { $0["kind"] as? String == "array" })
        XCTAssertEqual(PrototypeLimits.maxRepeatItems, literal["max"] as? Int)
        XCTAssertEqual(PrototypeLimits.maxDataDepth, limits["MAX_PROTOTYPE_DATA_DEPTH"])
        XCTAssertEqual(PrototypeLimits.maxDataArrayItems, limits["MAX_PROTOTYPE_DATA_ARRAY_ITEMS"])
        XCTAssertEqual(PrototypeLimits.maxDataPointerLength, limits["MAX_PROTOTYPE_DATA_POINTER_LENGTH"])
        XCTAssertEqual(PrototypeLimits.maxDataBytes, limits["MAX_PROTOTYPE_DATA_BYTES"])
        XCTAssertEqual(PrototypeLimits.maxRepeatPathCells, limits["MAX_PROTOTYPE_REPEAT_PATH_CELLS"])
    }

    func testExactLimitFixturesDecode() throws {
        for name in ["exact-node-limit", "repeat-exact-node-limit", "exact-depth-limit"] {
            XCTAssertNil(try rejection(data("valid/\(name).json")), name)
        }
    }

    func testOverLimitFixturesAreRefusedAtTheValidatorPath() throws {
        let expected: [String: String] = [
            "node-limit": "root.children[1999]: Node limit exceeded",
            "repeat-too-many-items": "root.repeat.items: Repeat item limit exceeded",
            "depth-limit": "Tree depth limit exceeded",
        ]
        for (name, message) in expected {
            let wrapper = try XCTUnwrap(
                JSONSerialization
                    .jsonObject(with: data("invalid/\(name).json")) as? [String: Any]
            )
            let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(wrapper["spec"]))
            let reason = try XCTUnwrap(rejection(spec), name)
            XCTAssertTrue(reason.contains(message), "\(name): \(reason)")
        }
    }

    func testExpandedRepeatOverTheNodeLimitIsRefusedBeforeExpansion() throws {
        let wrapper = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data("invalid/repeat-node-limit-expanded.json")) as? [String: Any]
        )
        let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(wrapper["spec"]))
        let reason = try XCTUnwrap(rejection(spec))
        XCTAssertTrue(reason.hasSuffix("Node limit exceeded"), reason)
        XCTAssertTrue(reason.hasPrefix("root.children[79].repeat["), reason)
    }

    private func pathRepeatSpec(_ root: JSONValue, data: [String: JSONValue]? = nil) throws -> Data {
        // Absent by default: authored limits must not depend on pointer resolution.
        var fields: [String: JSONValue] = [
            "id": .string("authored"),
            "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "root": root,
        ]
        if let data { fields["data"] = .object(data) }
        return try JSONEncoder().encode(JSONValue.object(fields))
    }

    private func nodeCount(_ node: PrototypeNode) -> Int {
        1 + (node.children ?? []).reduce(0) { $0 + nodeCount($1) } + (node.child.map(nodeCount) ?? 0)
    }

    private func pathRepeat(children: [JSONValue]) -> JSONValue {
        .object([
            "type": .string("column"), "children": .array(children),
            "repeat": .object(["items": .object(["path": .string("/e")]), "as": .string("item")]),
        ])
    }

    private func deepChildChain(_ levels: Int) -> JSONValue {
        var node: JSONValue = .object(["type": .string("spacer")])
        for _ in 0 ..< levels {
            node = .object(["type": .string("scroll"), "child": node])
        }
        return node
    }

    private func assertLimit(
        _ expected: String, file: StaticString = #filePath, line: UInt = #line,
        operation: () throws -> Void
    ) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                XCTFail("Unexpected error: \(error)", file: file, line: line)
                return
            }
            XCTAssertEqual(context.debugDescription, expected, file: file, line: line)
        }
    }

    func testSharedAuthoredBudgetFixtureDecodesWithHostExpandedCount() throws {
        let spec = try JSONDecoder().decode(
            PrototypeSpec.self, from: data("valid/data-repeat-path-authored-budget.json")
        )
        XCTAssertEqual(nodeCount(spec.root), 1908)
    }

    func testAuthoredTemplateAndExpandedNodeBudgetsAreIndependent() throws {
        let spacer: JSONValue = .object(["type": .string("spacer")])
        let template = pathRepeat(children: Array(repeating: spacer, count: 1500))
        let root: JSONValue = .object([
            "type": .string("column"),
            "children": .array(Array(repeating: spacer, count: 1997) + [template]),
        ])
        try PrototypeLimits.guardAuthoredTree(root)
        let empty = try pathRepeatSpec(root, data: ["e": .array([])])
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: empty)
        XCTAssertEqual(nodeCount(spec.root), 1999)
        let twoItems: JSONValue = .array([.object(["n": .number(0)]), .object(["n": .number(1)])])
        XCTAssertEqual(
            try rejection(pathRepeatSpec(root, data: ["e": twoItems])),
            "root.children[1997].repeat[0].children[1]: Node limit exceeded"
        )
    }

    func testAuthoredPathTemplateExceedsItsOwnNodeBudgetWithoutData() throws {
        let spacer: JSONValue = .object(["type": .string("spacer")])
        let root = pathRepeat(children: Array(repeating: spacer, count: 2001))
        XCTAssertEqual(try rejection(pathRepeatSpec(root)), "root.children[2000]: Node limit exceeded")
    }

    func testPathTemplateInsideLiteralRepeatUsesAuthoredBudgetOnce() throws {
        let spacer: JSONValue = .object(["type": .string("spacer")])
        let template = pathRepeat(children: Array(repeating: spacer, count: 1500))
        let root: JSONValue = .object([
            "type": .string("column"), "children": .array([template]),
            "repeat": .object([
                "items": .array(Array(repeating: .object([:]), count: 128)), "as": .string("item"),
            ]),
        ])
        // The host rejects nested repeats; the direct-client guard still stays bounded and
        // counts the inner template once, rather than 128 times.
        try PrototypeLimits.guardAuthoredTree(root)
    }

    func testEmptyAndMalformedRepeatTemplatesHaveBoundedDepth() {
        let template = deepChildChain(3000)
        let expected = "root.children[0]" + String(repeating: ".child", count: 23)
            + ": Tree depth limit exceeded"
        let sources: [JSONValue] = [.array([]), .string("x")]
        for items in sources {
            let root: JSONValue = .object([
                "type": .string("column"), "children": .array([template]),
                "repeat": .object(["items": items, "as": .string("item")]),
            ])
            assertLimit(expected) { try PrototypeLimits.guardAuthoredTree(root) }
        }
    }

    func testPathRepeatSingleChildTemplateHasBoundedDepth() {
        let root: JSONValue = .object([
            "type": .string("column"), "child": deepChildChain(3000),
            "repeat": .object(["items": .object(["path": .string("/e")]), "as": .string("item")]),
        ])
        assertLimit("root" + String(repeating: ".child", count: 24) + ": Tree depth limit exceeded") {
            try PrototypeLimits.guardAuthoredTree(root)
        }
    }

    func testPathRepeatSingleChildUsesTheIndependentTemplateBudget() throws {
        let spacer: JSONValue = .object(["type": .string("spacer")])
        var template: [String: JSONValue] = [
            "type": .string("column"), "children": .array(Array(repeating: spacer, count: 1999)),
        ]
        var fields: [String: JSONValue] = [
            "type": .string("column"), "child": .object(template),
            "repeat": .object(["items": .object(["path": .string("/e")]), "as": .string("item")]),
        ]
        try PrototypeLimits.guardAuthoredTree(.object(fields))
        template["children"] = .array(Array(repeating: spacer, count: 2000))
        fields["child"] = .object(template)
        assertLimit("root.child.children[1999]: Node limit exceeded") {
            try PrototypeLimits.guardAuthoredTree(.object(fields))
        }
    }

    func testRepeatPathCellGuardHasItsOwnDepthBound() {
        let root = pathRepeat(children: [deepChildChain(3000)])
        let expected = "root.children[0]" + String(repeating: ".child", count: 23)
            + ": Tree depth limit exceeded"
        assertLimit(expected) { try PrototypeLimits.guardRepeatPathCells(root, data: nil) }
    }

    func testRepeatsNestedInUncountedTemplatesStillHaveBoundedDepth() {
        let sources: [JSONValue] = [.array([.object([:])]), .array([]), .object(["path": .string("/e")])]
        for items in sources {
            let nested: JSONValue = .object([
                "type": .string("column"), "children": .array([deepChildChain(3000)]),
                "repeat": .object(["items": items, "as": .string("item")]),
            ])
            let root = pathRepeat(children: [nested])
            let expected = "root.children[0].children[0]" + String(repeating: ".child", count: 22)
                + ": Tree depth limit exceeded"
            assertLimit(expected) { try PrototypeLimits.guardAuthoredTree(root) }
        }
    }

    func testUncountedTemplatesUseTheExactIndependentNodeBoundary() throws {
        let spacer: JSONValue = .object(["type": .string("spacer")])
        let sources: [JSONValue] = [.object(["path": .string("/e")]), .array([]), .string("x")]
        for items in sources {
            var fields: [String: JSONValue] = [
                "type": .string("column"),
                "children": .array(Array(repeating: spacer, count: 2000)),
                "repeat": .object(["items": items, "as": .string("item")]),
            ]
            try PrototypeLimits.guardAuthoredTree(.object(fields))
            fields["children"] = .array(Array(repeating: spacer, count: 2001))
            assertLimit("root.children[2000]: Node limit exceeded") {
                try PrototypeLimits.guardAuthoredTree(.object(fields))
            }
        }
    }

    func testResolvedLiteralRepeatRetainsInstanceErrorPath() {
        let spacer: JSONValue = .object(["type": .string("spacer")])
        let root: JSONValue = .object([
            "type": .string("column"), "children": .array(Array(repeating: spacer, count: 1000)),
            "repeat": .object(["items": .array([.object([:]), .object([:])]), "as": .string("item")]),
        ])
        assertLimit("root.repeat[1].children[999]: Node limit exceeded") {
            try PrototypeLimits.guardTree(root)
        }
    }

    func testAuthoredPathRepeatsExceedNodeLimitWithoutData() throws {
        let column: JSONValue = .object([
            "type": .string("column"), "children": .array([]),
            "repeat": .object(["items": .object(["path": .string("/missing")]), "as": .string("item")]),
        ])
        let root: JSONValue = .object([
            "type": .string("column"), "children": .array(Array(repeating: column, count: 2001)),
        ])
        XCTAssertEqual(try rejection(pathRepeatSpec(root)), "root.children[1999]: Node limit exceeded")
    }

    func testAuthoredPathRepeatTemplateDepthLimitWithoutData() throws {
        var template: JSONValue = .object(["type": .string("text"), "text": .string("leaf")])
        for _ in 0 ..< 23 {
            template = .object(["type": .string("scroll"), "child": template])
        }
        let root: JSONValue = .object([
            "type": .string("column"), "children": .array([template]),
            "repeat": .object(["items": .object(["path": .string("/missing")]), "as": .string("item")]),
        ])
        XCTAssertEqual(
            try rejection(pathRepeatSpec(root)),
            "root.children[0]" + String(repeating: ".child", count: 23) + ": Tree depth limit exceeded"
        )
    }
}
