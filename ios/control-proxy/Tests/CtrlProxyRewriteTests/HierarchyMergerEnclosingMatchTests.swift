@testable import CtrlProxyRewrite
import XCTest

/// Synthetic, simulator-free containment parity fixtures, including malformed bounds.
final class HierarchyMergerEnclosingMatchTests: XCTestCase {
    func testNoEnclosingNode() {
        XCTAssertNil(enclosingID([sdkBounds(0, 0, 10, 10)], query: bounds(20, 20, 30, 30)))
        XCTAssertNil(enclosingID([], query: bounds(0, 0, 0, 0)))
    }

    func testSmallestNestedEncloserWins() {
        let nodes: [SdkBounds] = [sdkBounds(0, 0, 100, 100), sdkBounds(10, 10, 90, 90), sdkBounds(20, 20, 80, 80)]
        XCTAssertEqual(enclosingID(nodes, query: bounds(30, 30, 70, 70)), 2)
    }

    func testEqualAreaUsesDocumentOrderRatherThanWindowOrder() {
        let earlier = sdkBounds(0, 0, 10, 10)
        let later = sdkBounds(-1, 0, 9, 10)
        let query = bounds(2, 2, 7, 7)

        // The left window visits the later node first. Swapping document order
        // changes which bounds win, but the winning NodeID must always be zero.
        XCTAssertEqual(enclosingID([earlier, later], query: query), 0)
        XCTAssertEqual(enclosingID([later, earlier], query: query), 0)
    }

    func testZeroSizeQueryAndNode() {
        XCTAssertEqual(enclosingID([sdkBounds(-5, -5, 5, 5), sdkBounds(0, 0, 0, 0)], query: bounds(0, 0, 0, 0)), 1)
    }

    func testIdenticalBoundsAllowSelfAndChooseEarlierID() {
        let node = sdkBounds(1, 2, 11, 12)
        XCTAssertEqual(enclosingID([node], query: bounds(1, 2, 11, 12)), 0)
        XCTAssertEqual(enclosingID([node, node], query: bounds(1, 2, 11, 12)), 0)
    }

    func testToleranceBoundaryOnEverySide() {
        let nodes: [SdkBounds] = [sdkBounds(0, 0, 10, 10)]
        XCTAssertEqual(enclosingID(nodes, query: bounds(-2, -2, 12, 12)), 0)
        let queries: [ElementBounds] = [
            bounds(-3, 0, 10, 10), bounds(0, -3, 10, 10), bounds(0, 0, 13, 10), bounds(0, 0, 10, 13),
        ]
        for query in queries {
            XCTAssertNil(enclosingID(nodes, query: query))
        }
    }

    func testInvertedBoundsKeepSignedArea() {
        let nodes: [SdkBounds] = [sdkBounds(0, 0, 10, 10), sdkBounds(4, 0, 2, 10)]
        XCTAssertEqual(enclosingID(nodes, query: bounds(4, 2, 2, 8)), 1)
    }

    func testSingleExtremeNodeDoesNotComputeItsArea() {
        let node = sdkBounds(Int.min, Int.min, Int.max, Int.max)
        XCTAssertEqual(
            HierarchyMerger.smallestEnclosingIDs(nodeBounds: [node], queries: [bounds(0, 0, 1, 1)]),
            [0]
        )
    }

    func testExtremeAreasSaturateAndKeepAreaThenNodeIDOrdering() {
        let nodes: [SdkBounds] = [
            sdkBounds(Int.min, Int.min, Int.max, Int.max), // Positive saturated area.
            sdkBounds(Int.max, 0, Int.min, 10), // Negative width overflow.
            sdkBounds(0, Int.min, 10, Int.max), // Positive height overflow.
            sdkBounds(0, 0, 4_000_000_000, 4_000_000_000), // Positive product overflow.
            sdkBounds(0, 4_000_000_000, 4_000_000_000, 0), // Negative product overflow.
        ]
        let queries: [ElementBounds] = [
            bounds(Int.max, 0, Int.min, 10),
            bounds(0, Int.min, 10, Int.max),
            bounds(0, 0, 4_000_000_000, 4_000_000_000),
            bounds(0, 4_000_000_000, 4_000_000_000, 0),
        ]
        let expected: [Int?] = [1, 0, 0, 4]
        let reference = ReferenceScan(nodeBounds: nodes)

        XCTAssertEqual(HierarchyMerger.smallestEnclosingIDs(nodeBounds: nodes, queries: queries), expected)
        XCTAssertEqual(queries.map { reference.enclosingID(query: $0) }, expected)
    }

    func testSaturatingSignedArea() {
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(0, 0, 10, 20)), 200)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(4, 0, 2, 10)), -20)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(4, 0, 4, 10)), 0)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(Int.min, 0, Int.max, 1)), Int.max)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(Int.max, 0, Int.min, 1)), Int.min)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(0, Int.min, 1, Int.max)), Int.max)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(0, Int.max, 1, Int.min)), Int.min)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(0, 0, 4_000_000_000, 4_000_000_000)), Int.max)
        XCTAssertEqual(HierarchyMerger.saturatingSignedArea(of: sdkBounds(0, 4_000_000_000, 4_000_000_000, 0)), Int.min)
    }

    func testQueryExtremesDoNotOverflowToleranceThresholds() {
        let nodes: [SdkBounds] = [sdkBounds(0, 0, 10, 10)]
        let queries: [ElementBounds] = [
            bounds(Int.max, Int.max, Int.min, Int.min),
            bounds(Int.min, Int.min, Int.max, Int.max),
        ]
        let expected: [Int?] = [0, nil]
        let reference = ReferenceScan(nodeBounds: nodes)
        XCTAssertEqual(HierarchyMerger.smallestEnclosingIDs(nodeBounds: nodes, queries: queries), expected)
        for query in queries {
            XCTAssertEqual(enclosingID(nodes, query: query), reference.enclosingID(query: query))
        }
    }

    func testIncompatibleBestEncloserDoesNotFallBackToLargerCompatibleNode() {
        let query = UIElementInfo(resourceId: "query", className: "UIKitButton", bounds: bounds(30, 30, 70, 70))
        let xcuitest = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(className: "UIView", bounds: bounds(0, 0, 100, 100), node: [query])
        )
        let incompatible = SdkViewNode(
            className: "_UIHostingView", bounds: sdkBounds(20, 20, 80, 80),
            accessibilityIdentifier: "other", backgroundColor: "smallest"
        )
        let compatible = SdkViewNode(
            className: "_UIHostingView", bounds: sdkBounds(10, 10, 90, 90),
            backgroundColor: "larger", children: [incompatible]
        )
        let sdk = SdkViewHierarchy(
            timestamp: 1000, bundleId: "com.test.app", screenScale: 3,
            screenWidth: 100, screenHeight: 100,
            root: SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 100, 100), children: [compatible])
        )
        let result = HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk)
        let mergedQuery = result.hierarchy?.node?.first { $0.resourceId == "query" }

        XCTAssertNotNil(mergedQuery)
        XCTAssertNil(mergedQuery?.extras)
    }

    // Split into eight seed families for headroom under the 100 ms per-test budget.
    // Across all families: 60 lists of sizes 1...60 and 13,530 exact ID comparisons.
    func testDifferentialSeedOne() {
        assertDifferential(seed: 1, sizeOffset: 0, expectedTrees: 8, expectedComparisons: 1720)
    }

    func testDifferentialSeedTwo() {
        assertDifferential(seed: 0x5837, sizeOffset: 1, expectedTrees: 8, expectedComparisons: 1776)
    }

    func testDifferentialSeedThree() {
        assertDifferential(seed: 0x8662, sizeOffset: 2, expectedTrees: 8, expectedComparisons: 1832)
    }

    func testDifferentialSeedFour() {
        assertDifferential(seed: 0xC0FFEE, sizeOffset: 3, expectedTrees: 8, expectedComparisons: 1888)
    }

    func testDifferentialSeedFive() {
        assertDifferential(seed: 0x5838, sizeOffset: 4, expectedTrees: 7, expectedComparisons: 1505)
    }

    func testDifferentialSeedSix() {
        assertDifferential(seed: 0x8663, sizeOffset: 5, expectedTrees: 7, expectedComparisons: 1554)
    }

    func testDifferentialSeedSeven() {
        assertDifferential(seed: 0xC0FFEF, sizeOffset: 6, expectedTrees: 7, expectedComparisons: 1603)
    }

    func testDifferentialSeedEight() {
        assertDifferential(seed: 0xDEAD_BEEF, sizeOffset: 7, expectedTrees: 7, expectedComparisons: 1652)
    }

    private func assertDifferential(seed: UInt64, sizeOffset: Int, expectedTrees: Int, expectedComparisons: Int) {
        var generator = Generator(state: seed)
        var treeCount = 0
        var comparisons = 0
        for tree in 0 ..< expectedTrees {
            let baseCount: Int = tree * 8
            let nodeCount: Int = baseCount + sizeOffset + 1
            let nodes: [SdkBounds] = nodeList(count: nodeCount, generator: &generator)
            let queries: [ElementBounds] = queryList(nodes: nodes, generator: &generator)
            let reference = ReferenceScan(nodeBounds: nodes)
            let actual: [Int?] = HierarchyMerger.smallestEnclosingIDs(nodeBounds: nodes, queries: queries)
            XCTAssertEqual(actual.count, queries.count)
            for (query, indexedID) in zip(queries, actual) {
                XCTAssertEqual(indexedID, reference.enclosingID(query: query))
            }
            comparisons += actual.count
            treeCount += 1
        }
        XCTAssertEqual(treeCount, expectedTrees)
        XCTAssertEqual(comparisons, expectedComparisons)
    }

    /// Old algorithm, sorting once per list and carrying original offsets to observe identity.
    private struct ReferenceScan {
        private let sortedByArea: [(offset: Int, element: SdkBounds)]

        init(nodeBounds: [SdkBounds]) {
            let entries: [(offset: Int, element: SdkBounds)] = Array(nodeBounds.enumerated())
            sortedByArea = entries.sorted { lhs, rhs in
                let lhsArea = HierarchyMerger.saturatingSignedArea(of: lhs.element)
                let rhsArea = HierarchyMerger.saturatingSignedArea(of: rhs.element)
                return lhsArea == rhsArea ? lhs.offset < rhs.offset : lhsArea < rhsArea
            }
        }

        func enclosingID(query: ElementBounds) -> Int? {
            let tol = 2
            for node in sortedByArea {
                let nodeBounds = node.element
                let (left, leftOverflow) = nodeBounds.left.subtractingReportingOverflow(tol)
                let (top, topOverflow) = nodeBounds.top.subtractingReportingOverflow(tol)
                let (right, rightOverflow) = nodeBounds.right.addingReportingOverflow(tol)
                let (bottom, bottomOverflow) = nodeBounds.bottom.addingReportingOverflow(tol)
                if leftOverflow || left <= query.left,
                   topOverflow || top <= query.top,
                   rightOverflow || right >= query.right,
                   bottomOverflow || bottom >= query.bottom
                {
                    return node.offset
                }
            }
            return nil
        }
    }

    private func nodeList(count: Int, generator: inout Generator) -> [SdkBounds] {
        var nodes: [SdkBounds] = []
        nodes.reserveCapacity(count)
        for id in 0 ..< count {
            let left = generator.int(-100 ... 100)
            let top = generator.int(-100 ... 100)
            let width = generator.int(10 ... 100)
            let height = generator.int(10 ... 100)
            let previous = nodes.last ?? sdkBounds(left, top, left + width, top + height)
            let first = nodes.first ?? previous
            let node: SdkBounds
            switch id % 8 {
            case 0:
                node = sdkBounds(left, top, left + width, top + height)
            case 1:
                node = sdkBounds(previous.left + 1, previous.top + 1, previous.right - 1, previous.bottom - 1)
            case 2:
                node = previous
            case 3:
                node = sdkBounds(left, top, left, top)
            case 4:
                node = sdkBounds(left, top, left - width, top + height)
            case 5:
                node = sdkBounds(left, top, left + width, top - height)
            case 6:
                node = sdkBounds(first.left + 3, first.top - 3, first.right + 3, first.bottom - 3)
            default:
                node = sdkBounds(-width, -height, -width / 2, -height / 2)
            }
            nodes.append(node)
        }
        return nodes
    }

    private func queryList(nodes: [SdkBounds], generator: inout Generator) -> [ElementBounds] {
        var queries: [ElementBounds] = []
        queries.reserveCapacity(nodes.count * 7 + 12)
        let deltas: [Int] = [-3, -2, -1, 1, 2, 3]
        for node in nodes {
            queries.append(bounds(node.left, node.top, node.right, node.bottom))
            // Every endpoint receives each of +/-1, +/-2, +/-3 across these variants.
            for delta in deltas {
                queries.append(bounds(node.left + delta, node.top - delta, node.right - delta, node.bottom + delta))
            }
        }
        for _ in 0 ..< 8 {
            queries.append(bounds(
                generator.int(-150 ... 150), generator.int(-150 ... 150),
                generator.int(-150 ... 150), generator.int(-150 ... 150)
            ))
        }
        let fixedQueries: [ElementBounds] = [
            bounds(0, 0, 0, 0), bounds(-10, -10, -10, -10),
            bounds(5, 5, -5, -5), bounds(-150, 0, 150, 0),
        ]
        queries.append(contentsOf: fixedQueries)
        return queries
    }

    private struct Generator {
        var state: UInt64

        mutating func int(_ range: ClosedRange<Int>) -> Int {
            let multiplier: UInt64 = 6_364_136_223_846_793_005
            let increment: UInt64 = 1_442_695_040_888_963_407
            let product: UInt64 = state &* multiplier
            state = product &+ increment
            let rangeSize: Int = range.upperBound - range.lowerBound + 1
            let sample: UInt64 = state >> 32
            let offset = Int(sample % UInt64(rangeSize))
            return range.lowerBound + offset
        }
    }

    private func enclosingID(_ nodes: [SdkBounds], query: ElementBounds) -> Int? {
        let ids: [Int?] = HierarchyMerger.smallestEnclosingIDs(nodeBounds: nodes, queries: [query])
        return ids.first.flatMap { $0 }
    }

    private func bounds(_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> ElementBounds {
        ElementBounds(left: left, top: top, right: right, bottom: bottom)
    }

    private func sdkBounds(_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> SdkBounds {
        SdkBounds(left: left, top: top, right: right, bottom: bottom)
    }
}
