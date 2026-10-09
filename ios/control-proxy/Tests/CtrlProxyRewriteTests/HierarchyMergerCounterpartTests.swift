import CtrlProxyRewrite
import XCTest

/// Counterpart matching across class families and stale SDK snapshots (#10851).
final class HierarchyMergerCounterpartTests: XCTestCase {
    func testSameIdentifierAcrossClassFamiliesIsEnrichedNotInjected() {
        let link = UIElementInfo(resourceId: "terms", className: "UILink", bounds: bounds(17, 223, 373, 265))
        let sdkTextView = SdkViewNode(
            className: "UITextView", bounds: sdkBounds(18, 223, 373, 266),
            accessibilityIdentifier: "terms", backgroundColor: "white"
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 402, 874), children: [
            SdkViewNode(
                className: "PlatformGroupContainer",
                bounds: sdkBounds(2, 116, 401, 386),
                children: [sdkTextView]
            ),
        ])

        let nodes = flatten(merge(xcChildren: [link], sdkRoot: sdkRoot).hierarchy)

        XCTAssertEqual(nodes.filter(isInjected).map(\.className), [])
        XCTAssertEqual(nodes.first { $0.className == "UILink" }?.extras?["sdk.backgroundColor"], "white")
    }

    func testHostingScrollViewIsTheScrollViewCounterpartAndKeepsSdkOnlyDescendants() {
        let row = UIElementInfo(resourceId: "row", className: "UIButton", bounds: bounds(17, 132, 384, 188))
        let scrollView = UIElementInfo(className: "UIScrollView", bounds: bounds(1, 0, 400, 874), node: [row])
        let badge = SdkViewNode(
            className: "BadgeView", bounds: sdkBounds(300, 140, 340, 160), accessibilityLabel: "New"
        )
        let hostingScrollView = SdkViewNode(
            className: "HostingScrollView",
            bounds: sdkBounds(2, 0, 401, 874),
            children: [
                SdkViewNode(className: "PlatformGroupContainer", bounds: sdkBounds(2, 116, 401, 386), children: [
                    SdkViewNode(
                        className: "UIButton",
                        bounds: sdkBounds(18, 132, 385, 188),
                        accessibilityIdentifier: "row"
                    ),
                    badge,
                ]),
            ]
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 402, 874), children: [
            // The hosting view sits exactly on the XCUITest scroll view's frame, so the
            // bounds-only fallback alone would pick it and inject the page beside it.
            SdkViewNode(className: "HostingView", bounds: sdkBounds(1, 0, 400, 874), children: [hostingScrollView]),
        ])

        let merged = merge(xcChildren: [scrollView], sdkRoot: sdkRoot).hierarchy
        let nodes = flatten(merged)
        let mergedScrollView = nodes.first { $0.className == "UIScrollView" }

        XCTAssertFalse(nodes.contains { isInjected($0) && $0.className == "HostingScrollView" })
        XCTAssertFalse(nodes.contains { isInjected($0) && $0.resourceId == "row" })
        let injectedUnderScrollView = flatten(mergedScrollView).filter(isInjected)
        XCTAssertEqual(injectedUnderScrollView.compactMap(\.text), ["New"])
    }

    /// A second SDK copy of an XCUITest node is not injected, but an SDK-only child it
    /// carries still lands under that XCUITest node rather than being dropped.
    func testRepresentedCopyPlacesItsSdkOnlyChildUnderTheXcuitestNode() {
        let link = UIElementInfo(resourceId: "terms", className: "UILink", bounds: bounds(17, 223, 373, 265))
        let primary = SdkViewNode(
            className: "UITextView",
            bounds: sdkBounds(17, 223, 373, 265),
            accessibilityIdentifier: "terms"
        )
        let copy = SdkViewNode(
            className: "UITextView", bounds: sdkBounds(18, 223, 373, 266), accessibilityIdentifier: "terms", children: [
                SdkViewNode(
                    className: "LinkHighlight",
                    bounds: sdkBounds(91, 223, 214, 244),
                    accessibilityLabel: "Terms"
                ),
            ]
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 402, 874), children: [
            primary,
            SdkViewNode(className: "UIKitPlatformViewHost", bounds: sdkBounds(18, 223, 373, 266), children: [copy]),
        ])

        let merged = merge(xcChildren: [link], sdkRoot: sdkRoot).hierarchy
        let mergedLink = flatten(merged).first { $0.className == "UILink" }

        XCTAssertFalse(flatten(merged).contains { isInjected($0) && $0.resourceId == "terms" })
        XCTAssertEqual(mergedLink?.node?.map(\.text), ["Terms"])
        XCTAssertEqual(mergedLink?.node?.first?.extras?["sdk.source"], "sdkWalker")
    }

    func testStaleSnapshotDoesNotInjectAMovedCopyOrItsChildren() {
        let nodes = flatten(merge(xcChildren: [movedList()], sdkRoot: movedSdkRoot(), sdkTimestamp: 1000).hierarchy)

        XCTAssertEqual(nodes.filter(isInjected).map(\.className), [])
        XCTAssertEqual(nodes.first { $0.resourceId == "list" }?.bounds?.top, 100)
    }

    /// A snapshot taken after the capture keeps the identifier fallback's injection.
    func testFreshSnapshotKeepsIdentifierFallbackInjection() {
        let nodes = flatten(merge(xcChildren: [movedList()], sdkRoot: movedSdkRoot(), sdkTimestamp: 3000).hierarchy)
        let list = nodes.first { $0.resourceId == "list" && !isInjected($0) }

        XCTAssertEqual(list?.node?.filter(isInjected).compactMap(\.text), ["Moved badge"])
    }

    // MARK: - Helpers

    private func movedList() -> UIElementInfo {
        UIElementInfo(resourceId: "list", className: "UIScrollView", bounds: bounds(12, 100, 390, 300))
    }

    /// The same list 126 pt lower, as a snapshot taken before keyboard avoidance.
    private func movedSdkRoot() -> SdkViewNode {
        SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 402, 874), children: [
            SdkViewNode(className: "PlatformContainer", bounds: sdkBounds(12, 226, 390, 426), children: [
                SdkViewNode(
                    className: "HostingScrollView", bounds: sdkBounds(12, 226, 390, 426),
                    accessibilityIdentifier: "list", children: [
                        SdkViewNode(
                            className: "BadgeView", bounds: sdkBounds(300, 240, 340, 260),
                            accessibilityLabel: "Moved badge"
                        ),
                    ]
                ),
            ]),
        ])
    }

    private func merge(
        xcChildren: [UIElementInfo],
        sdkRoot: SdkViewNode,
        sdkTimestamp: Int64 = 1000
    )
        -> ViewHierarchy
    {
        let xcuitest = ViewHierarchy(
            updatedAt: 2000,
            packageName: "com.test.app",
            hierarchy: UIElementInfo(className: "UIView", bounds: bounds(0, 0, 402, 874), node: xcChildren)
        )
        let sdk = SdkViewHierarchy(
            timestamp: sdkTimestamp, bundleId: "com.test.app", screenScale: 3,
            screenWidth: 402, screenHeight: 874, root: sdkRoot
        )
        return HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk)
    }

    private func isInjected(_ node: UIElementInfo) -> Bool {
        node.extras?["sdk.source"] == "sdkWalker"
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
