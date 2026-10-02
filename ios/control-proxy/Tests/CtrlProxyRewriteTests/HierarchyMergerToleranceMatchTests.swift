@testable import CtrlProxyRewrite
import XCTest

/// Synthetic, simulator-free fixtures; these are not a real-pair golden-replay corpus.
final class HierarchyMergerToleranceMatchTests: XCTestCase {
    func testExactBoundsBeatNearDocumentPredecessor() {
        let result = merge(sdkNodes: [
            candidate(21, 120, 320, 164, color: "near"),
            candidate(20, 120, 320, 164, color: "exact"),
        ])

        XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "exact")
    }

    func testAllCoordinatesWithinToleranceMatch() {
        // Delta (+1, -2, 0, +2) exercises all four endpoint windows.
        let result = merge(sdkNodes: [candidate(21, 118, 320, 166, color: "within")])

        XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "within")
    }

    func testBothToleranceBoundariesAreInclusive() {
        for offset in [-2, 2] {
            let result = merge(sdkNodes: [
                candidate(20 + offset, 120 + offset, 320 + offset, 164 + offset, color: "boundary"),
            ])

            XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "boundary")
        }
    }

    func testEqualDistanceUsesDocumentOrderRatherThanDeltaOrder() {
        let positive = candidate(21, 120, 320, 164, color: "positive")
        let negative = candidate(19, 120, 320, 164, color: "negative")

        // Before: the delta loop picked the later -1 node. After: the earlier +1
        // node wins the L-infinity tie. This assertion fails with the old matcher.
        XCTAssertEqual(
            queryNode(in: merge(sdkNodes: [positive, negative]))?.extras?["sdk.backgroundColor"],
            "positive"
        )
        // Swap only document order to prove that geometry sign does not decide.
        XCTAssertEqual(
            queryNode(in: merge(sdkNodes: [negative, positive]))?.extras?["sdk.backgroundColor"],
            "negative"
        )
    }

    func testNearestBeatsEarlierFartherNode() {
        let result = merge(sdkNodes: [
            candidate(18, 120, 320, 164, color: "farther"),
            candidate(20, 120, 320, 165, color: "nearest"),
        ])

        // Before: (-2, 0, 0, 0) won by loop order. After: (0, 0, 0, +1)
        // wins by L-infinity distance. This assertion fails with the old matcher.
        XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "nearest")
    }

    func testOutsideToleranceOnAnyCoordinateDoesNotDirectlyMatch() {
        // Each candidate is three points outside one window and cannot enclose
        // the query even with the margin. Only the uncolored root can enrich it.
        let result = merge(sdkNodes: [
            candidate(23, 120, 320, 164, color: "left"),
            candidate(20, 123, 320, 164, color: "top"),
            candidate(20, 120, 317, 164, color: "right"),
            candidate(20, 120, 320, 161, color: "bottom"),
        ])

        XCTAssertNotNil(queryNode(in: result))
        XCTAssertNil(queryNode(in: result)?.extras?["sdk.backgroundColor"])
        let injected = flatten(result.hierarchy).filter { $0.extras?["sdk.source"] == "sdkWalker" }
        XCTAssertEqual(injected.compactMap { $0.extras?["sdk.backgroundColor"] }, ["left", "top", "right", "bottom"])
    }

    func testNoDirectMatchDoesNotInjectEnclosingNodesChildrenIntoQuery() {
        let far = SdkViewNode(
            className: "_UIHostingView", bounds: sdkBounds(17, 120, 320, 164),
            backgroundColor: "enclosing", children: [
                SdkViewNode(
                    className: "SDKOnlyBadge", bounds: sdkBounds(30, 130, 40, 140),
                    accessibilityLabel: "Badge"
                ),
            ]
        )
        let result = merge(sdkNodes: [far])

        // Delta -3 on the left is outside tolerance but still encloses. Enrichment
        // is unchanged; only a direct hit would inject the badge under the query.
        XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "enclosing")
        XCTAssertTrue(queryNode(in: result)?.node?.isEmpty ?? true)
        let injected = flatten(result.hierarchy).first { $0.className == "_UIHostingView" }
        XCTAssertEqual(injected?.extras?["sdk.source"], "sdkWalker")
        XCTAssertEqual(injected?.node?.first?.className, "SDKOnlyBadge")
    }

    func testManyEquidistantCandidatesAreDeterministic() {
        let candidates = (0 ..< 24).map { index in
            candidate(
                22, 118 + index % 5, 318 + index % 5, 162 + index % 5,
                color: "candidate-\(index)", identifier: "sdk-\(index)"
            )
        }
        let expected = merge(sdkNodes: candidates)
        let expectedNodes = flatten(expected.hierarchy)
        XCTAssertEqual(queryNode(in: expected)?.extras?["sdk.backgroundColor"], "candidate-0")

        for _ in 0 ..< 20 {
            let nodes = flatten(merge(sdkNodes: candidates).hierarchy)
            XCTAssertEqual(nodes.map(\.className), expectedNodes.map(\.className))
            XCTAssertEqual(nodes.map(\.extras), expectedNodes.map(\.extras))
        }
    }

    func testConflictingExactNodeDoesNotShadowLaterCompatibleDuplicate() {
        let result = merge(sdkNodes: [
            candidate(20, 120, 320, 164, color: "conflicting", identifier: "other"),
            candidate(20, 120, 320, 164, color: "compatible"),
        ], resourceId: "query")

        // The later node has no identifier, so the old identifier fallback cannot
        // recover it after the first-inserted exact key fails accept.
        XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "compatible")
    }

    func testNegativeCoordinatesMatchWithinTolerance() {
        let query = UIElementInfo(className: "UIKitButton", bounds: bounds(-20, -40, 30, -10))
        let result = merge(
            sdkNodes: [candidate(-18, -42, 31, -9, color: "negative")],
            query: query
        )

        XCTAssertEqual(queryNode(in: result)?.extras?["sdk.backgroundColor"], "negative")
    }

    func testCoordinateIndexIncludesBoundariesDuplicatesAndNegativeValues() {
        let values = [-3, 2, -1, 2, 5]

        XCTAssertEqual(HierarchyMerger.coordinateIDs(values: values, inRange: -1 ... 2), Set([1, 2, 3]))
        XCTAssertEqual(HierarchyMerger.coordinateIDs(values: values, inRange: 2 ... 2), Set([1, 3]))
        XCTAssertEqual(HierarchyMerger.coordinateIDs(values: values, inRange: -3 ... -1), Set([0, 2]))
        XCTAssertEqual(HierarchyMerger.coordinateIDs(values: values, inRange: 3 ... 4), Set<Int>())
        XCTAssertEqual(HierarchyMerger.coordinateIDs(values: values, inRange: -10 ... 10), Set(0 ..< values.count))
        XCTAssertEqual(HierarchyMerger.coordinateIDs(values: [], inRange: -1 ... 1), Set<Int>())
    }

    private func merge(
        sdkNodes: [SdkViewNode],
        resourceId: String? = nil,
        query: UIElementInfo? = nil
    )
        -> ViewHierarchy
    {
        // Different class families force the query past strict matching into the
        // bounds-only fallback. The shared UIView roots match and enable injection.
        let query = query ?? UIElementInfo(
            resourceId: resourceId, className: "UIKitButton", bounds: bounds(20, 120, 320, 164)
        )
        let xcuitest = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(className: "UIView", bounds: bounds(0, 0, 375, 812), node: [query])
        )
        let sdkRoot = SdkViewNode(
            className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: sdkNodes
        )
        let sdk = SdkViewHierarchy(
            timestamp: 1000, bundleId: "com.test.app", screenScale: 3,
            screenWidth: 375, screenHeight: 812, root: sdkRoot
        )
        return HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk)
    }

    private func queryNode(in result: ViewHierarchy) -> UIElementInfo? {
        flatten(result.hierarchy).first { $0.className == "UIKitButton" }
    }

    private func candidate(
        _ left: Int, _ top: Int, _ right: Int, _ bottom: Int,
        color: String, identifier: String? = nil
    )
        -> SdkViewNode
    {
        SdkViewNode(
            className: "_UIHostingView", bounds: sdkBounds(left, top, right, bottom),
            accessibilityIdentifier: identifier, backgroundColor: color
        )
    }

    private func flatten(_ root: UIElementInfo?) -> [UIElementInfo] {
        guard let root else { return [] }
        return [root] + (root.node ?? []).flatMap { flatten($0) }
    }

    private func bounds(_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> ElementBounds {
        ElementBounds(left: left, top: top, right: right, bottom: bottom)
    }

    private func sdkBounds(_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> SdkBounds {
        SdkBounds(left: left, top: top, right: right, bottom: bottom)
    }
}
