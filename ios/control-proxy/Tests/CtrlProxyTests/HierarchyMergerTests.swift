import XCTest
@testable import CtrlProxy

final class HierarchyMergerTests: XCTestCase {

    // MARK: - Helpers

    private func makeElement(
        className: String = "UIView",
        bounds: ElementBounds = ElementBounds(left: 0, top: 0, right: 100, bottom: 100),
        text: String? = nil,
        contentDesc: String? = nil,
        extras: [String: String]? = nil,
        children: [UIElementInfo]? = nil
    ) -> UIElementInfo {
        UIElementInfo(
            text: text,
            contentDesc: contentDesc,
            className: className,
            bounds: bounds,
            extras: extras,
            node: children
        )
    }

    private func makeSdkNode(
        className: String = "UIView",
        bounds: SdkBounds = SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
        accessibilityLabel: String? = nil,
        accessibilityTraits: [String] = [],
        accessibilityCustomActions: [String] = [],
        gestureRecognizers: [SdkGestureInfo] = [],
        alpha: Float = 1.0,
        backgroundColor: String? = nil,
        cornerRadius: Float = 0,
        isAccessibilityElement: Bool = false,
        accessibilityElementsHidden: Bool = false,
        hasTapTarget: Bool = false,
        isOccluded: Bool = false,
        isUserInteractionEnabled: Bool = true,
        children: [SdkViewNode]? = nil
    ) -> SdkViewNode {
        SdkViewNode(
            className: className,
            bounds: bounds,
            accessibilityLabel: accessibilityLabel,
            isAccessibilityElement: isAccessibilityElement,
            accessibilityElementsHidden: accessibilityElementsHidden,
            accessibilityTraits: accessibilityTraits,
            accessibilityCustomActions: accessibilityCustomActions,
            gestureRecognizers: gestureRecognizers,
            alpha: alpha,
            backgroundColor: backgroundColor,
            cornerRadius: cornerRadius,
            isUserInteractionEnabled: isUserInteractionEnabled,
            hasTapTarget: hasTapTarget,
            isOccluded: isOccluded,
            children: children
        )
    }

    private func makeHierarchy(root: UIElementInfo) -> ViewHierarchy {
        ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: root,
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812
        )
    }

    private func makeSdkHierarchy(root: SdkViewNode) -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            root: root
        )
    }

    // MARK: - No SDK Hierarchy (graceful fallback)

    func testMergeWithNilSdkReturnsUnchanged() {
        let root = makeElement(text: "Hello")
        let hierarchy = makeHierarchy(root: root)

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: nil)

        XCTAssertEqual(result.hierarchy?.text, "Hello")
        XCTAssertNil(result.hierarchy?.extras)
    }

    func testMergeWithNilSdkRootReturnsUnchanged() {
        let root = makeElement(text: "Hello")
        let hierarchy = makeHierarchy(root: root)
        let sdkHierarchy = SdkViewHierarchy(
            timestamp: 1000, bundleId: nil, screenScale: 3.0,
            screenWidth: 375, screenHeight: 812, root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdkHierarchy)

        XCTAssertNil(result.hierarchy?.extras)
    }

    // MARK: - Exact Match

    func testExactBoundsMatch() {
        let xcuiRoot = makeElement(
            className: "UIButton",
            bounds: ElementBounds(left: 10, top: 20, right: 110, bottom: 60)
        )
        let sdkRoot = makeSdkNode(
            className: "UIButton",
            bounds: SdkBounds(left: 10, top: 20, right: 110, bottom: 60),
            accessibilityTraits: ["button"],
            hasTapTarget: true
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let extras = result.hierarchy?.extras
        XCTAssertNotNil(extras)
        XCTAssertEqual(extras?["sdk.accessibilityTraits"], "button")
        XCTAssertEqual(extras?["sdk.hasTapTarget"], "true")
    }

    // MARK: - Tolerance Matching

    func testBoundsToleranceMatch() {
        let xcuiRoot = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 20, right: 100, bottom: 50)
        )
        // SDK bounds off by 1pt on each edge
        let sdkRoot = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 11, top: 21, right: 101, bottom: 51),
            accessibilityTraits: ["staticText"],
            backgroundColor: "#FF0000FF"
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let extras = result.hierarchy?.extras
        XCTAssertNotNil(extras)
        XCTAssertEqual(extras?["sdk.accessibilityTraits"], "staticText")
        XCTAssertEqual(extras?["sdk.backgroundColor"], "#FF0000FF")
    }

    func testBoundsOutOfToleranceNoMatch() {
        let xcuiRoot = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 20, right: 100, bottom: 50)
        )
        // SDK bounds off by 5pt — exceeds ±2 tolerance
        let sdkRoot = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 15, top: 25, right: 105, bottom: 55),
            accessibilityTraits: ["staticText"]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        XCTAssertNil(result.hierarchy?.extras)
    }

    // MARK: - Class Name Mismatch

    func testClassNameMismatchNoMatch() {
        let xcuiRoot = makeElement(
            className: "UIButton",
            bounds: ElementBounds(left: 10, top: 20, right: 100, bottom: 50)
        )
        let sdkRoot = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 10, top: 20, right: 100, bottom: 50),
            accessibilityTraits: ["staticText"]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        XCTAssertNil(result.hierarchy?.extras)
    }

    // MARK: - Children

    func testChildrenAreEnriched() {
        let childElement = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 50, right: 200, bottom: 80)
        )
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
            children: [childElement]
        )

        let childSdkNode = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 10, top: 50, right: 200, bottom: 80),
            accessibilityTraits: ["header"]
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 812),
            children: [childSdkNode]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let childExtras = result.hierarchy?.node?.first?.extras
        XCTAssertEqual(childExtras?["sdk.accessibilityTraits"], "header")
    }

    // MARK: - All Extras Fields

    func testAllExtrasFieldsPopulated() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 100)
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
            accessibilityTraits: ["button", "selected"],
            accessibilityCustomActions: ["Delete", "Share"],
            gestureRecognizers: [SdkGestureInfo(type: "UITapGestureRecognizer", isEnabled: true)],
            alpha: 0.8,
            backgroundColor: "#00FF00FF",
            cornerRadius: 12.0,
            isAccessibilityElement: true,
            accessibilityElementsHidden: true,
            hasTapTarget: true,
            isOccluded: true,
            isUserInteractionEnabled: false
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let extras = result.hierarchy?.extras
        XCTAssertNotNil(extras)
        XCTAssertEqual(extras?["sdk.accessibilityTraits"], "button,selected")
        XCTAssertEqual(extras?["sdk.accessibilityCustomActions"], "Delete,Share")
        XCTAssertEqual(extras?["sdk.gestureRecognizers"], "UITapGestureRecognizer(enabled)")
        XCTAssertEqual(extras?["sdk.alpha"], "0.8")
        XCTAssertEqual(extras?["sdk.backgroundColor"], "#00FF00FF")
        XCTAssertEqual(extras?["sdk.cornerRadius"], "12.0")
        XCTAssertEqual(extras?["sdk.isAccessibilityElement"], "true")
        XCTAssertEqual(extras?["sdk.accessibilityElementsHidden"], "true")
        XCTAssertEqual(extras?["sdk.hasTapTarget"], "true")
        XCTAssertEqual(extras?["sdk.isOccluded"], "true")
        XCTAssertEqual(extras?["sdk.isUserInteractionEnabled"], "false")
    }

    // MARK: - Existing Extras Preserved

    func testExistingExtrasPreserved() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 100),
            extras: ["custom.key": "custom.value"]
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
            hasTapTarget: true
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let extras = result.hierarchy?.extras
        XCTAssertEqual(extras?["custom.key"], "custom.value")
        XCTAssertEqual(extras?["sdk.hasTapTarget"], "true")
    }

    // MARK: - Hierarchy Metadata Preserved

    func testHierarchyMetadataPreserved() {
        let xcuiRoot = makeElement()
        let hierarchy = ViewHierarchy(
            updatedAt: 12345,
            packageName: "com.test.app",
            hierarchy: xcuiRoot,
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            fallbackToSpringboard: true
        )

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: nil)

        XCTAssertEqual(result.updatedAt, 12345)
        XCTAssertEqual(result.packageName, "com.test.app")
        XCTAssertEqual(result.screenScale, 3.0)
        XCTAssertEqual(result.screenWidth, 375)
        XCTAssertEqual(result.screenHeight, 812)
        XCTAssertEqual(result.fallbackToSpringboard, true)
    }
}
