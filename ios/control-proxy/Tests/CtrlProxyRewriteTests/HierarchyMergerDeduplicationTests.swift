import CtrlProxyRewrite
import XCTest

/// Small, simulator-free hierarchy fixtures for the two reported SDK walker shapes.
final class HierarchyMergerDeduplicationTests: XCTestCase {
    func testFormsTextFieldsKeepXcuitestValuesAndGainSdkExtras() {
        let fields = [
            UIElementInfo(
                text: "Name", value: "Ada", resourceId: "name", className: "UIKitTextField",
                bounds: bounds(20, 120, 320, 164), role: "textfield"
            ),
            UIElementInfo(
                text: "Email", value: "ada@example.com", resourceId: "email", className: "UIKitTextField",
                bounds: bounds(20, 180, 320, 224), role: "textfield"
            ),
        ]
        let sdkFields = [
            SdkViewNode(
                className: "UITextField", bounds: sdkBounds(21, 120, 321, 164),
                accessibilityIdentifier: "name", backgroundColor: "blue"
            ),
            SdkViewNode(
                className: "UITextField", bounds: sdkBounds(20, 181, 320, 225),
                accessibilityIdentifier: "email", hasTapTarget: true
            ),
        ]
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: [
            SdkViewNode(className: "_UIHostingView", bounds: sdkBounds(0, 100, 375, 260), children: sdkFields),
            SdkViewNode(className: "_UIHostingView", bounds: sdkBounds(0, 100, 375, 260), children: sdkFields),
        ])

        let result = merge(xcChildren: fields, sdkRoot: sdkRoot)
        let textFields = flatten(result.hierarchy)
            .filter { $0.className == "UIKitTextField" || $0.className == "UITextField" }

        XCTAssertEqual(textFields.count, 2)
        XCTAssertEqual(textFields.map(\.value), ["Ada", "ada@example.com"])
        XCTAssertEqual(textFields[0].extras?["sdk.backgroundColor"], "blue")
        XCTAssertEqual(textFields[1].extras?["sdk.hasTapTarget"], "true")
        XCTAssertTrue(textFields.allSatisfy { $0.extras?["sdk.source"] == nil })
    }

    func testSearchBarSubtreeAppearsOnce() {
        let label = UIElementInfo(
            text: "Search videos",
            className: "UISearchBarTextFieldLabel",
            bounds: bounds(32, 91, 250, 112)
        )
        let field = UIElementInfo(
            value: "query", resourceId: "video-search", className: "UISearchBarTextField",
            bounds: bounds(24, 80, 330, 124), node: [label]
        )
        let container = UIElementInfo(
            className: "_UISearchBarSearchContainerView", bounds: bounds(16, 72, 340, 132), node: [field]
        )
        let searchBar = UIElementInfo(className: "UIKitSearchBar", bounds: bounds(8, 64, 348, 140), node: [container])

        let sdkLabel = SdkViewNode(
            className: "UISearchBarTextFieldLabel", bounds: sdkBounds(32, 91, 250, 112),
            accessibilityLabel: "Search videos", backgroundColor: "gray"
        )
        let sdkField = SdkViewNode(
            className: "UISearchBarTextField", bounds: sdkBounds(24, 80, 330, 124),
            accessibilityIdentifier: "video-search", children: [sdkLabel]
        )
        let sdkContainer = SdkViewNode(
            className: "_UISearchBarSearchContainerView", bounds: sdkBounds(16, 72, 340, 132), children: [sdkField]
        )
        let sdkSearchBar = SdkViewNode(
            className: "UISearchBar", bounds: sdkBounds(8, 64, 348, 140), children: [sdkContainer]
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: [
            SdkViewNode(className: "UIView", bounds: sdkBounds(0, 60, 375, 150), children: [sdkSearchBar]),
            SdkViewNode(className: "UIView", bounds: sdkBounds(0, 60, 375, 150), children: [sdkSearchBar]),
        ])

        let result = merge(xcChildren: [searchBar], sdkRoot: sdkRoot)
        let nodes = flatten(result.hierarchy)
        for className in [
            "UIKitSearchBar",
            "_UISearchBarSearchContainerView",
            "UISearchBarTextField",
            "UISearchBarTextFieldLabel",
        ] {
            XCTAssertEqual(nodes.filter { $0.className == className }.count, 1, className)
        }
        XCTAssertEqual(nodes.first { $0.className == "UISearchBarTextField" }?.value, "query")
        XCTAssertEqual(
            nodes.first { $0.className == "UISearchBarTextFieldLabel" }?.extras?["sdk.backgroundColor"],
            "gray"
        )
    }

    func testSdkOnlyNodeIsInjectedUnderMatchedParent() {
        let sdkOnly = SdkViewNode(
            className: "SDKOnlyBadge", bounds: sdkBounds(300, 40, 340, 60),
            accessibilityLabel: "New", backgroundColor: "orange"
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: [sdkOnly])

        let result = merge(xcChildren: [], sdkRoot: sdkRoot)
        let badge = result.hierarchy?.node?.first
        XCTAssertEqual(badge?.className, "SDKOnlyBadge")
        XCTAssertEqual(badge?.text, "New")
        XCTAssertEqual(badge?.extras?["sdk.source"], "sdkWalker")
        XCTAssertEqual(badge?.extras?["sdk.backgroundColor"], "orange")
    }

    func testRepeatedSdkOnlySubtreeIsInjectedOnce() {
        let child = SdkViewNode(
            className: "SDKOnlyLabel", bounds: sdkBounds(40, 50, 100, 70), accessibilityLabel: "Details"
        )
        let subtree = SdkViewNode(
            className: "SDKOnlyCard", bounds: sdkBounds(20, 30, 130, 90),
            accessibilityIdentifier: "card", children: [child]
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: [subtree, subtree])

        let nodes = flatten(merge(xcChildren: [], sdkRoot: sdkRoot).hierarchy)
        XCTAssertEqual(nodes.filter { $0.className == "SDKOnlyCard" }.count, 1)
        XCTAssertEqual(nodes.filter { $0.className == "SDKOnlyLabel" }.count, 1)
    }

    func testColocatedSdkWrappersWithDifferentChildrenKeepBothChildren() {
        let first = SdkViewNode(
            className: "SDKOnlyCard", bounds: sdkBounds(20, 30, 130, 90), children: [
                SdkViewNode(className: "SDKOnlyLabel", bounds: sdkBounds(30, 40, 80, 60), accessibilityLabel: "First"),
            ]
        )
        let second = SdkViewNode(
            className: "SDKOnlyCard", bounds: sdkBounds(20, 30, 130, 90), children: [
                SdkViewNode(
                    className: "SDKOnlyLabel",
                    bounds: sdkBounds(80, 40, 120, 60),
                    accessibilityLabel: "Second"
                ),
            ]
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: [first, second])

        let nodes = flatten(merge(xcChildren: [], sdkRoot: sdkRoot).hierarchy)
        XCTAssertEqual(nodes.filter { $0.className == "SDKOnlyCard" }.count, 2)
        XCTAssertEqual(nodes.filter { $0.className == "SDKOnlyLabel" }.compactMap(\.text), ["First", "Second"])
    }

    func testDifferentIdentifiersAtSameBoundsStayDistinct() {
        let frame = bounds(20, 120, 320, 164)
        let xcField = UIElementInfo(value: "original", resourceId: "first", className: "UITextField", bounds: frame)
        let sdkField = SdkViewNode(
            className: "UITextField", bounds: sdkBounds(20, 120, 320, 164),
            accessibilityIdentifier: "second", backgroundColor: "red"
        )
        let sdkRoot = SdkViewNode(className: "UIView", bounds: sdkBounds(0, 0, 375, 812), children: [sdkField])

        let fields = flatten(merge(xcChildren: [xcField], sdkRoot: sdkRoot).hierarchy)
            .filter { $0.className == "UITextField" }
        XCTAssertEqual(fields.count, 2)
        XCTAssertEqual(fields.first { $0.resourceId == "first" }?.value, "original")
        XCTAssertNil(fields.first { $0.resourceId == "first" }?.extras?["sdk.backgroundColor"])
        XCTAssertEqual(fields.first { $0.resourceId == "second" }?.extras?["sdk.source"], "sdkWalker")
    }

    private func merge(xcChildren: [UIElementInfo], sdkRoot: SdkViewNode) -> ViewHierarchy {
        let xcuitest = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(className: "UIView", bounds: bounds(0, 0, 375, 812), node: xcChildren)
        )
        let sdk = SdkViewHierarchy(
            timestamp: 1000, bundleId: "com.test.app", screenScale: 3,
            screenWidth: 375, screenHeight: 812, root: sdkRoot
        )
        return HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk)
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
