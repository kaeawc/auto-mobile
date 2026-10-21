@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeFlowGridTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
    }

    private func fixture(_ name: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(contentsOf: fixtures.appendingPathComponent(name + ".json"))
        )
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private func nodeCount(_ node: PrototypeNode) -> Int {
        1 + (node.children ?? []).reduce(0) { $0 + nodeCount($1) } + (node.child.map(nodeCount) ?? 0)
    }

    func testEverySharedValidFlowGridFixtureDecodes() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: fixtures.path)
            .filter { ($0.hasPrefix("flow-") || $0.hasPrefix("grid-")) && $0.hasSuffix(".json") }
        XCTAssertFalse(names.isEmpty)
        for name in names {
            let spec = try JSONDecoder().decode(
                PrototypeSpec.self,
                from: Data(contentsOf: fixtures.appendingPathComponent(name))
            )
            XCTAssertGreaterThan(nodeCount(spec.root), 0, name)
        }
    }

    func testSharedFlowFieldsRepeatAndNodeCounts() throws {
        let basic = try fixture("flow-basic")
        XCTAssertEqual(basic.root.type, "flow")
        XCTAssertEqual(basic.root.style?.spacing, 8)
        XCTAssertEqual(basic.root.style?.runSpacing, 12)
        XCTAssertEqual(nodeCount(basic.root), 3)
        let repeated = try fixture("flow-max-lines-repeat")
        XCTAssertEqual(repeated.root.maxLines, 1)
        XCTAssertEqual(repeated.root.children?.compactMap(\.text), ["One", "Two", "Three"])
        XCTAssertEqual(nodeCount(repeated.root), 4, "maxLines never removes decoded children")
        XCTAssertEqual(repeated.root.drawnChildren(holds: { $0.holds([:]) }).count, 3)
    }

    func testSharedGridFieldsSpansAndRepeat() throws {
        let fixed = try fixture("grid-fixed-columns-span")
        let grid = try XCTUnwrap(fixed.root.child)
        XCTAssertEqual(grid.columns, .fixed(3))
        XCTAssertEqual(grid.children?.compactMap(\.span), [2, 2, 3])
        XCTAssertEqual(grid.style?.runSpacing, 16)
        XCTAssertEqual(nodeCount(fixed.root), 6)
        let adaptive = try fixture("grid-adaptive-min-width")
        XCTAssertEqual(adaptive.root.columns, .adaptive(minWidth: 100))
        XCTAssertEqual(adaptive.root.children?.compactMap(\.text), ["One", "Two"])
        XCTAssertEqual(adaptive.root.children?.compactMap(\.span), [12, 12])
        XCTAssertEqual(nodeCount(adaptive.root), 3)
    }

    func testAdaptiveCountsMatchKotlinBoundaryPins() {
        let adaptive = PrototypeGridColumns.adaptive(minWidth: 100)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: adaptive, available: 320, gap: 10), 3)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: adaptive, available: 319, gap: 10), 2)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: adaptive, available: 0, gap: 10), 1)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: adaptive, available: 300, gap: 0), 3)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: .fixed(4), available: 10, gap: 20), 4)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: adaptive, available: nil, gap: 10), 1)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: .fixed(0), available: 100, gap: 0), 1)
        XCTAssertEqual(PrototypeGridPlacement.columnCount(columns: .adaptive(minWidth: 0), available: 100, gap: 0), 1)
        XCTAssertEqual(
            PrototypeGridPlacement.columnCount(
                columns: .adaptive(minWidth: Double.leastNonzeroMagnitude),
                available: 100,
                gap: 0
            ),
            Int(Int32.max)
        )
    }

    func testSpansMatchKotlinRowMajorPackingWithoutBackfill() {
        XCTAssertEqual(PrototypeGridPlacement.cells(count: 3, spans: [2, 2, 1, 12, 1]), [
            .init(row: 0, column: 0, span: 2),
            .init(row: 1, column: 0, span: 2),
            .init(row: 1, column: 2, span: 1),
            .init(row: 2, column: 0, span: 3),
            .init(row: 3, column: 0, span: 1),
        ])
        XCTAssertEqual(PrototypeGridPlacement.cells(count: 3, spans: []), [])
        XCTAssertEqual(PrototypeGridPlacement.cells(count: 1, spans: [1, 12]), [
            .init(row: 0, column: 0, span: 1), .init(row: 1, column: 0, span: 1),
        ])
        XCTAssertEqual(PrototypeGridPlacement.cells(count: 0, spans: [0, -2]), [
            .init(row: 0, column: 0, span: 1), .init(row: 1, column: 0, span: 1),
        ])
    }

    func testGridEqualSlotsTallestRowsAndIndependentGaps() {
        var measured: [Double?] = []
        let frames = PrototypeGridPlacement.frames(
            columns: .fixed(3), available: 320, spacing: 10, runSpacing: 5, spans: [2, 2, 1]
        ) { index, width in
            measured.append(width)
            return (width ?? 0, Double((index + 1) * 10))
        }
        XCTAssertEqual(measured, [210, 210, 100])
        XCTAssertEqual(frames.children, [
            PrototypeRect(x: 0, y: 0, width: 210, height: 10),
            PrototypeRect(x: 0, y: 15, width: 210, height: 20),
            PrototypeRect(x: 220, y: 15, width: 100, height: 30),
        ])
        XCTAssertEqual(frames.width, 320)
        XCTAssertEqual(frames.height, 45)
        let fallback = PrototypeGridPlacement.frames(
            columns: .fixed(1), available: 100, spacing: 10, runSpacing: nil, spans: [1, 1]
        ) { _, width in (width ?? 0, 20) }
        XCTAssertEqual(fallback.height, 50)
        let narrow = PrototypeGridPlacement.frames(
            columns: .fixed(4), available: 10, spacing: 20, runSpacing: nil, spans: [4]
        ) { _, width in
            XCTAssertEqual(width, 10)
            return (width ?? 0, 20)
        }
        XCTAssertEqual(narrow.children.first?.width, 10)
    }

    func testUnboundedGridDerivesNaturalSlotsAndAdaptiveUsesOneColumn() {
        let fixed = PrototypeGridPlacement.frames(
            columns: .fixed(3), available: nil, spacing: 10, runSpacing: nil, spans: [2, 1]
        ) { index, width in
            XCTAssertNil(width)
            return (index == 0 ? 210 : 90, 20)
        }
        XCTAssertEqual(fixed.width, 320)
        XCTAssertEqual(fixed.children.map(\.width), [210, 100])
        let adaptive = PrototypeGridPlacement.frames(
            columns: .adaptive(minWidth: 100), available: nil, spacing: 10, runSpacing: nil, spans: [12, 1]
        ) { _, _ in (80, 20) }
        XCTAssertEqual(adaptive.width, 80)
        XCTAssertEqual(adaptive.height, 50)
        XCTAssertEqual(adaptive.children.map(\.y), [0, 30])
    }

    func testFlowExactFitOversizeAndUnboundedLineBreaking() {
        XCTAssertEqual(
            PrototypeFlowPlacement.lines(widths: [40, 50, 10, 120], available: 100, spacing: 10),
            [0, 0, 1, 2]
        )
        XCTAssertEqual(PrototypeFlowPlacement.lines(widths: [120, 10], available: 100, spacing: 0), [0, 1])
        XCTAssertEqual(PrototypeFlowPlacement.lines(widths: [120, 10], available: nil, spacing: 10), [0, 0])
        XCTAssertEqual(PrototypeFlowPlacement.lines(widths: [], available: 0, spacing: 10), [])
        XCTAssertEqual(PrototypeFlowPlacement.lines(widths: [0, 0], available: 0, spacing: 0), [0, 0])
    }

    func testFlowCapClipsHeightAndKeepsAllOverflowFrames() {
        let sizes: [(width: Double, height: Double)] = [(40, 10), (50, 20), (10, 8), (120, 5)]
        let capped = PrototypeFlowPlacement.frames(
            sizes: sizes,
            available: 100,
            spacing: 10,
            runSpacing: 4,
            maxLines: 1
        )
        XCTAssertEqual(capped.children, [
            PrototypeRect(x: 0, y: 0, width: 40, height: 10),
            PrototypeRect(x: 50, y: 0, width: 50, height: 20),
            PrototypeRect(x: 0, y: 24, width: 10, height: 8),
            PrototypeRect(x: 0, y: 36, width: 120, height: 5),
        ])
        XCTAssertEqual(capped.height, 20)
        XCTAssertEqual(capped.width, 120)
        let full = PrototypeFlowPlacement.frames(
            sizes: sizes,
            available: 100,
            spacing: 10,
            runSpacing: 4,
            maxLines: nil
        )
        XCTAssertEqual(full.children, capped.children)
        XCTAssertEqual(full.height, 41)
        XCTAssertEqual(
            PrototypeFlowPlacement.frames(sizes: sizes, available: 100, spacing: 10, runSpacing: 4, maxLines: 0).height,
            capped.height
        )
        XCTAssertEqual(
            PrototypeFlowPlacement.frames(sizes: [], available: 100, spacing: 10, runSpacing: 4, maxLines: 1).height,
            0
        )
    }

    func testContainersPreserveAccessibilityStyleOverridesAndAnchorTraversal() throws {
        for type in ["flow", "grid"] {
            XCTAssertEqual(prototypeAccessibilityGrouping(type: type, tappable: false), .contain)
            XCTAssertEqual(prototypeAccessibilityGrouping(type: type, tappable: true), .combine)
            let root = try node("""
            {"type":"\(
                type
            )","testTag":"container","contentDescription":"Choices","style":{"spacing":8,"runSpacing":12},
             "styleWhen":[{"when":{"key":"open","equals":true},"style":{"runSpacing":20}}],
             "children":[{"type":"text","text":"Child","testTag":"child","span":2,
               "anchor":{"type":"bounds","bounds":{"x":0,"y":0,"width":10,"height":10}}}]}
            """)
            XCTAssertEqual(root.identifier, "container")
            XCTAssertEqual(root.accessibilityLabel(state: [:], pager: nil, tappable: false), "Choices")
            XCTAssertEqual(root.resolvedStyle(state: ["open": .bool(true)])?.spacing, 8)
            XCTAssertEqual(root.resolvedStyle(state: ["open": .bool(true)])?.runSpacing, 20)
            XCTAssertEqual(root.resolvedStyle(state: [:])?.runSpacing, 12)
            XCTAssertEqual(root.layeredAnchors(state: [:], pages: [:]).map(\.path), ["root.children[0]"])
            XCTAssertNotNil(root.tapTarget(identifier: "child", state: [:]))
        }
    }

    func testFlowGridHaveTheSameNodeAndDepthBackstopsAsColumn() throws {
        for type in ["flow", "grid"] {
            let leaf: JSONValue = .object(["type": .string("spacer")])
            let tooMany: JSONValue = .object([
                "type": .string(type), "children": .array(Array(repeating: leaf, count: PrototypeLimits.maxNodes)),
            ])
            XCTAssertThrowsError(try PrototypeLimits.guardTree(tooMany)) { error in
                guard case let DecodingError.dataCorrupted(context) = error
                else { return XCTFail("Unexpected error: \(error)") }
                XCTAssertEqual(context.debugDescription, "root.children[1999]: Node limit exceeded")
            }
            var deep = leaf
            for _ in 0 ..< PrototypeLimits.maxDepth {
                deep = .object(["type": .string(type), "children": .array([deep])])
            }
            XCTAssertThrowsError(try PrototypeLimits.guardTree(deep))
        }
    }

    func testFlowGridCapabilityIsAdvertisedOnce() {
        XCTAssertEqual(PrototypeAgentProtocol.flowGridCapability, "prototype_flow_grid_v1")
        XCTAssertEqual(PrototypeAgentProtocol.capabilities.filter { $0 == "prototype_flow_grid_v1" }.count, 1)
    }
}
