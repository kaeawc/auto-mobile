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

    // The legacy tie-break exists only so the golden replay (#5837) can measure the
    // reviewed behavior change; these pin it to the pre-#8662 delta-loop picks.
    func testLegacyTieBreakFollowsDeltaLoopOrder() {
        let positive = candidate(21, 120, 320, 164, color: "positive")
        let negative = candidate(19, 120, 320, 164, color: "negative")

        for order in [[positive, negative], [negative, positive]] {
            XCTAssertEqual(
                queryNode(in: merge(sdkNodes: order, tieBreak: .legacyDeltaLoopOrder))?
                    .extras?["sdk.backgroundColor"],
                "negative"
            )
        }
        let farther = candidate(18, 120, 320, 164, color: "farther")
        let nearest = candidate(20, 120, 320, 165, color: "nearest")
        XCTAssertEqual(
            queryNode(in: merge(sdkNodes: [nearest, farther], tieBreak: .legacyDeltaLoopOrder))?
                .extras?["sdk.backgroundColor"],
            "farther"
        )
    }

    func testLegacyTieBreakPrefersExactBoundsAndLetsAConflictingFirstNodeShadowItsKey() {
        let exact = candidate(20, 120, 320, 164, color: "exact")
        let near = candidate(18, 120, 320, 164, color: "near")
        XCTAssertEqual(
            queryNode(in: merge(sdkNodes: [near, exact], tieBreak: .legacyDeltaLoopOrder))?
                .extras?["sdk.backgroundColor"],
            "exact"
        )

        let result = merge(sdkNodes: [
            candidate(20, 120, 320, 164, color: "conflicting", identifier: "other"),
            candidate(20, 120, 320, 164, color: "compatible"),
        ], resourceId: "query", tieBreak: .legacyDeltaLoopOrder)
        // The old dictionary kept only the first node per key, so the compatible
        // duplicate was unreachable; the incompatible enclosing node is rejected too.
        XCTAssertNil(queryNode(in: result)?.extras?["sdk.backgroundColor"])
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

    func testCounterpartExtremeDifferencesDoNotMatch() {
        let coordinates = [(0, Int.min), (Int.min, 0), (Int.min, Int.max), (Int.max, Int.min)]
        for (queryCoordinate, nodeCoordinate) in coordinates {
            let query = UIElementInfo(
                className: "UIKitButton",
                bounds: bounds(queryCoordinate, queryCoordinate, queryCoordinate, queryCoordinate)
            )
            // Same class family exercises isCounterpart before nearest. Point
            // bounds cannot enclose the distant query and hide a failed match.
            let node = SdkViewNode(
                className: "UIKitButton",
                bounds: sdkBounds(nodeCoordinate, nodeCoordinate, nodeCoordinate, nodeCoordinate),
                backgroundColor: "extreme"
            )
            let result = merge(sdkNodes: [node], query: query)

            XCTAssertNotNil(queryNode(in: result))
            XCTAssertNil(queryNode(in: result)?.extras?["sdk.backgroundColor"])
            XCTAssertEqual(
                flatten(result.hierarchy).filter { $0.extras?["sdk.source"] == "sdkWalker" }.count,
                1
            )
        }
    }

    func testNearestToleranceWindowsAtIntegerExtremes() {
        let cases: [(query: ElementBounds, within: SdkBounds, outside: SdkBounds)] = [
            (
                bounds(Int.min, Int.min, Int.min, Int.min),
                sdkBounds(Int.min + 2, Int.min + 2, Int.min + 2, Int.min + 2),
                sdkBounds(Int.min + 3, Int.min + 3, Int.min + 3, Int.min + 3)
            ),
            (
                bounds(Int.max, Int.max, Int.max, Int.max),
                sdkBounds(Int.max - 2, Int.max - 2, Int.max - 2, Int.max - 2),
                sdkBounds(Int.max - 3, Int.max - 3, Int.max - 3, Int.max - 3)
            ),
            (
                bounds(Int.min, Int.max, Int.max, Int.min),
                sdkBounds(Int.min + 2, Int.max - 2, Int.max - 2, Int.min + 2),
                sdkBounds(Int.min + 3, Int.max - 3, Int.max - 3, Int.min + 3)
            ),
        ]
        for testCase in cases {
            let query = UIElementInfo(className: "UIKitButton", bounds: testCase.query)
            let within = SdkViewNode(
                className: "_UIHostingView", bounds: testCase.within, backgroundColor: "within"
            )
            let outside = SdkViewNode(
                className: "_UIHostingView", bounds: testCase.outside, backgroundColor: "outside"
            )
            XCTAssertEqual(
                queryNode(in: merge(sdkNodes: [outside, within], query: query))?.extras?["sdk.backgroundColor"],
                "within"
            )
            // An earlier out-of-range node cannot become a direct match. In
            // these cases it also cannot enclose the query on at least one side.
            XCTAssertNil(queryNode(in: merge(sdkNodes: [outside], query: query))?.extras?["sdk.backgroundColor"])
            let exact = SdkViewNode(
                className: "_UIHostingView",
                bounds: sdkBounds(testCase.query.left, testCase.query.top, testCase.query.right, testCase.query.bottom),
                backgroundColor: "exact"
            )
            XCTAssertEqual(
                queryNode(in: merge(sdkNodes: [within, exact], query: query))?.extras?["sdk.backgroundColor"],
                "exact"
            )
        }
    }

    func testNearestExtremeCoordinatesKeepDistanceAndDocumentOrder() {
        let query = UIElementInfo(
            className: "UIKitButton", bounds: bounds(Int.min, Int.max, Int.max, Int.min)
        )
        let farther = candidate(Int.min + 2, Int.max - 2, Int.max - 2, Int.min + 2, color: "farther")
        let earlier = candidate(Int.min + 1, Int.max, Int.max, Int.min, color: "earlier")
        let later = candidate(Int.min, Int.max - 1, Int.max, Int.min, color: "later")

        XCTAssertEqual(
            queryNode(in: merge(sdkNodes: [farther, earlier, later], query: query))?.extras?["sdk.backgroundColor"],
            "earlier"
        )
        XCTAssertEqual(
            queryNode(in: merge(sdkNodes: [farther, later, earlier], query: query))?.extras?["sdk.backgroundColor"],
            "later"
        )
    }

    func testBoundsDistanceSaturatesUnrepresentableDifferences() {
        // Int.min - 0 is representable but abs(Int.min) is not. Opposite
        // endpoints also exercise subtraction overflow in both directions.
        let pairs = [(Int.min, 0), (0, Int.min), (Int.min, Int.max), (Int.max, Int.min)]
        for (nodeCoordinate, queryCoordinate) in pairs {
            let nodes = [
                sdkBounds(nodeCoordinate, 0, 0, 0), sdkBounds(0, nodeCoordinate, 0, 0),
                sdkBounds(0, 0, nodeCoordinate, 0), sdkBounds(0, 0, 0, nodeCoordinate),
            ]
            let queries = [
                bounds(queryCoordinate, 0, 0, 0), bounds(0, queryCoordinate, 0, 0),
                bounds(0, 0, queryCoordinate, 0), bounds(0, 0, 0, queryCoordinate),
            ]
            for (node, query) in zip(nodes, queries) {
                XCTAssertEqual(HierarchyMerger.boundsDistance(node, query), Int.max)
            }
        }
        XCTAssertEqual(HierarchyMerger.boundsDistance(sdkBounds(-2, 1, 4, 8), bounds(0, 0, 4, 7)), 2)
        XCTAssertEqual(
            HierarchyMerger.boundsDistance(sdkBounds(Int.min, 0, Int.max, 0), bounds(Int.min, 0, Int.max, 0)),
            0
        )
    }

    func testSdkAndElementDimensionsSaturateBySign() {
        let cases: [(bounds: SdkBounds, width: Int, height: Int)] = [
            (sdkBounds(Int.min, Int.max, Int.max, Int.min), Int.max, Int.min),
            (sdkBounds(Int.max, Int.min, Int.min, Int.max), Int.min, Int.max),
            (sdkBounds(4, 6, 2, 3), -2, -3),
            (sdkBounds(0, 0, Int.min, Int.min), Int.min, Int.min),
            (sdkBounds(0, 0, Int.max, Int.max), Int.max, Int.max),
        ]
        for testCase in cases {
            let sdk = testCase.bounds
            let element = bounds(sdk.left, sdk.top, sdk.right, sdk.bottom)
            XCTAssertEqual(sdk.width, testCase.width)
            XCTAssertEqual(sdk.height, testCase.height)
            XCTAssertEqual(element.width, testCase.width)
            XCTAssertEqual(element.height, testCase.height)
        }
    }

    func testElementCentersUseHalfTheSaturatedSignedDimension() {
        let forward = bounds(Int.min, Int.min, Int.max, Int.max)
        let inverted = bounds(Int.max, Int.max, Int.min, Int.min)
        let point = bounds(Int.max, Int.min, Int.max, Int.min)
        let ordinary = bounds(4, 6, 1, 3)
        let nearEdges = bounds(Int.max - 2, Int.min + 2, Int.max, Int.min)

        XCTAssertEqual(forward.centerX, Int.min + Int.max / 2)
        XCTAssertEqual(forward.centerY, Int.min + Int.max / 2)
        XCTAssertEqual(inverted.centerX, Int.max + Int.min / 2)
        XCTAssertEqual(inverted.centerY, Int.max + Int.min / 2)
        XCTAssertEqual(point.centerX, Int.max)
        XCTAssertEqual(point.centerY, Int.min)
        XCTAssertEqual(ordinary.centerX, 3)
        XCTAssertEqual(ordinary.centerY, 5)
        XCTAssertEqual(nearEdges.centerX, Int.max - 1)
        XCTAssertEqual(nearEdges.centerY, Int.min + 1)
    }

    func testSdkDecodingPreservesExtremeAndInvertedEndpoints() throws {
        let json = """
        {"className":"UIView","bounds":{
            "left":\(Int.max),"top":\(Int.min),"right":\(Int.min),"bottom":\(Int.max)
        }}
        """
        let node = try JSONDecoder().decode(SdkViewNode.self, from: Data(json.utf8))

        XCTAssertEqual(node.bounds.left, Int.max)
        XCTAssertEqual(node.bounds.top, Int.min)
        XCTAssertEqual(node.bounds.right, Int.min)
        XCTAssertEqual(node.bounds.bottom, Int.max)
        XCTAssertEqual(node.bounds.width, Int.min)
        XCTAssertEqual(node.bounds.height, Int.max)
    }

    func testFullMergeWithExtremeNodePreservesOrdinaryNodes() throws {
        let ordinary = SdkViewNode(
            className: "UIKitButton", bounds: sdkBounds(20, 120, 320, 164), backgroundColor: "ordinary"
        )
        let baseline = merge(sdkNodes: [ordinary])
        let baselineRoot = try XCTUnwrap(baseline.hierarchy)
        let baselineQuery = try XCTUnwrap(queryNode(in: baseline))
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let extremeBounds = [
            sdkBounds(Int.min, Int.min, Int.max, Int.max),
            sdkBounds(Int.max, Int.min, Int.min, Int.max),
        ]
        for geometry in extremeBounds {
            // Same family as the ordinary root exercises counterpart checks
            // during both matching and SDK-only injection pruning.
            let extreme = SdkViewNode(className: "UIView", bounds: geometry, backgroundColor: "extreme")
            let result = merge(sdkNodes: [extreme, ordinary])
            let root = try XCTUnwrap(result.hierarchy)
            let query = try XCTUnwrap(queryNode(in: result))

            XCTAssertEqual(root.className, baselineRoot.className)
            XCTAssertEqual(root.extras, baselineRoot.extras)
            XCTAssertEqual(root.bounds?.left, baselineRoot.bounds?.left)
            XCTAssertEqual(root.bounds?.top, baselineRoot.bounds?.top)
            XCTAssertEqual(root.bounds?.right, baselineRoot.bounds?.right)
            XCTAssertEqual(root.bounds?.bottom, baselineRoot.bounds?.bottom)
            // Compare the complete ordinary child, including injected children,
            // rather than just the SDK color that identifies its match.
            XCTAssertEqual(try encoder.encode(query), try encoder.encode(baselineQuery))
            XCTAssertEqual(
                flatten(result.hierarchy).filter { $0.extras?["sdk.source"] == "sdkWalker" }.count,
                1
            )
        }
    }

    private func merge(
        sdkNodes: [SdkViewNode],
        resourceId: String? = nil,
        query: UIElementInfo? = nil,
        tieBreak: HierarchyMerger.ToleranceTieBreak = .nearestThenDocumentOrder
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
        return HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk, matchCounter: nil, tieBreak: tieBreak)
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
