@testable import CtrlProxy
import XCTest

final class HierarchyMergerTests: XCTestCase {
    // MARK: - Helpers

    private func makeElement(
        className: String = "UIView",
        bounds: ElementBounds = ElementBounds(left: 0, top: 0, right: 100, bottom: 100),
        text: String? = nil,
        contentDesc: String? = nil,
        extras: [String: String]? = nil,
        children: [UIElementInfo]? = nil
    )
        -> UIElementInfo
    {
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
        accessibilityIdentifier: String? = nil,
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
    )
        -> SdkViewNode
    {
        SdkViewNode(
            className: className,
            bounds: bounds,
            accessibilityLabel: accessibilityLabel,
            accessibilityIdentifier: accessibilityIdentifier,
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

    private func countResourceId(_ resourceId: String, in element: UIElementInfo?) -> Int {
        guard let element else { return 0 }
        let current = element.resourceId == resourceId ? 1 : 0
        return current + (element.node ?? []).reduce(0) { $0 + countResourceId(resourceId, in: $1) }
    }

    private func countClassName(_ className: String, in element: UIElementInfo?) -> Int {
        guard let element else { return 0 }
        let current = element.className == className ? 1 : 0
        return current + (element.node ?? []).reduce(0) { $0 + countClassName(className, in: $1) }
    }

    private func countText(_ text: String, in element: UIElementInfo?) -> Int {
        guard let element else { return 0 }
        let current = element.text == text ? 1 : 0
        return current + (element.node ?? []).reduce(0) { $0 + countText(text, in: $1) }
    }

    private func countNodes(in element: UIElementInfo?) -> Int {
        guard let element else { return 0 }
        return 1 + (element.node ?? []).reduce(0) { $0 + countNodes(in: $1) }
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

    func testMergePropagatesSdkSystemChromeAlongsideSafeArea() {
        let root = makeElement(text: "Hello")
        let hierarchy = makeHierarchy(root: root)
        let sdkHierarchy = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            safeAreaInsets: SdkEdgeInsets(top: 59, right: 0, bottom: 34, left: 0),
            systemChrome: SdkSystemChrome(
                visibility: "hidden",
                statusBar: "hidden",
                homeIndicatorAutoHideRequested: true,
                source: "ios-status-bar-manager"
            ),
            root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdkHierarchy)

        XCTAssertEqual(result.insets.safeArea?.top, 59)
        XCTAssertEqual(result.insets.systemChrome?.visibility, "hidden")
        XCTAssertEqual(result.insets.systemChrome?.statusBar, "hidden")
        XCTAssertEqual(result.insets.systemChrome?.homeIndicatorAutoHideRequested, true)
        XCTAssertEqual(result.insets.systemChrome?.source, "ios-status-bar-manager")
        XCTAssertEqual(result.insets.displayCutoutState.classification, "unknown")
        XCTAssertNil(result.insets.displayCutoutState.bounds)
    }

    func testIosSafeAreaDoesNotInferDynamicIslandCutout() {
        let hierarchy = makeHierarchy(root: makeElement(text: "Hello"))
        let sdkHierarchy = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 393,
            screenHeight: 852,
            safeAreaInsets: SdkEdgeInsets(top: 59, right: 0, bottom: 34, left: 0),
            root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdkHierarchy)

        XCTAssertEqual(result.insets.displayCutoutState.classification, "unknown")
        XCTAssertNil(result.insets.displayCutoutState.bounds)
    }

    func testMergeChromeOnlySdkPayloadPreservesUnavailableInsetMetadata() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: makeElement(text: "Hello"),
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            insets: .unavailable
        )
        let sdkHierarchy = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            systemChrome: SdkSystemChrome(
                visibility: "hidden",
                statusBar: "hidden",
                homeIndicatorAutoHideRequested: true,
                source: "ios-status-bar-manager"
            ),
            root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdkHierarchy)

        XCTAssertFalse(result.insets.available)
        XCTAssertEqual(result.insets.source, "unavailable")
        XCTAssertEqual(result.insets.units, "unknown")
        XCTAssertNil(result.insets.safeArea)
        XCTAssertEqual(result.insets.displayCutoutState.classification, "unknown")
        XCTAssertNil(result.insets.displayCutoutState.bounds)
        XCTAssertEqual(result.insets.systemChrome?.visibility, "hidden")
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

    /// The match-time neighborhood probe must handle tolerance applied to all four
    /// edges at once (each within ±2), which the old per-node pre-expansion covered
    /// via baked-in variants (issue #3634).
    func testBoundsToleranceMatchOnAllFourEdges() {
        let xcuiRoot = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 20, right: 100, bottom: 50)
        )
        // Each edge displaced by the full ±2 tolerance in mixed directions.
        let sdkRoot = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 12, top: 18, right: 102, bottom: 48),
            accessibilityTraits: ["staticText"],
            backgroundColor: "#00FF00FF"
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        XCTAssertEqual(result.hierarchy?.extras?["sdk.backgroundColor"], "#00FF00FF")
    }

    // MARK: - Class Name Mismatch (bounds-only fallback)

    func testClassNameMismatchMatchesByBounds() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 10, top: 20, right: 100, bottom: 50)
        )
        let sdkRoot = makeSdkNode(
            className: "_UIHostingView",
            bounds: SdkBounds(left: 10, top: 20, right: 100, bottom: 50),
            backgroundColor: "#FF0000FF",
            cornerRadius: 8.0
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let extras = result.hierarchy?.extras
        XCTAssertNotNil(extras, "Bounds-only fallback should match even when class names differ")
        XCTAssertEqual(extras?["sdk.backgroundColor"], "#FF0000FF")
        XCTAssertEqual(extras?["sdk.cornerRadius"], "8.0")
    }

    func testExactClassMatchPreferredOverBoundsOnly() {
        let xcuiRoot = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 20, right: 100, bottom: 50)
        )
        let exactSdkNode = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 10, top: 20, right: 100, bottom: 50),
            accessibilityTraits: ["staticText"],
            backgroundColor: "#00FF00FF"
        )
        let otherSdkNode = makeSdkNode(
            className: "_UIHostingView",
            bounds: SdkBounds(left: 10, top: 20, right: 100, bottom: 50),
            backgroundColor: "#FF0000FF"
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 812),
            children: [exactSdkNode, otherSdkNode]
        )
        let xcuiWrapper = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
            children: [xcuiRoot]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiWrapper),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let childExtras = result.hierarchy?.node?.first?.extras
        XCTAssertEqual(childExtras?["sdk.accessibilityTraits"], "staticText")
        XCTAssertEqual(childExtras?["sdk.backgroundColor"], "#00FF00FF")
    }

    func testEnrichesOwnerElementWithSdkSemanticLinks() {
        // The XCUITest snapshot of an inline-link text owner carries no links;
        // the in-app SDK supplies them and the merge must project them onto the
        // owning element as `semantic-links` (issue #5560).
        let owner = UIElementInfo(
            text: "Read the Terms of Service, contact Support, or review the Terms of Service again.",
            resourceId: "uikit_semantic_links_inline",
            className: "UITextView",
            bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 72)
        )
        let sdkOwner = SdkViewNode(
            className: "UITextView",
            bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 72),
            accessibilityIdentifier: "uikit_semantic_links_inline",
            semanticLinks: [
                SdkSemanticLink(text: "Terms of Service", occurrence: 0, start: 9, end: 25, centerX: 40, centerY: 20),
                SdkSemanticLink(text: "Support", occurrence: 0, start: 35, end: 42),
                SdkSemanticLink(text: "Terms of Service", occurrence: 1, start: 58, end: 74),
            ]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: owner),
            sdk: makeSdkHierarchy(root: sdkOwner)
        )

        let links = result.hierarchy?.semanticLinks
        XCTAssertEqual(links?.count, 3)
        XCTAssertEqual(links?.map(\.text), ["Terms of Service", "Support", "Terms of Service"])
        XCTAssertEqual(links?.map(\.occurrence), [0, 0, 1])
        XCTAssertEqual(links?[0].start, 9)
        XCTAssertEqual(links?[2].start, 58)
    }

    func testEnrichesOwnerElementWithSwiftUIRotorSemanticLinks() {
        // SwiftUI inline `AttributedString` links have no character range (they are
        // discovered from the element's `.link` rotor, not an attributed string), so
        // the SDK supplies text + occurrence + center only. The merge must still
        // project them onto the owning element (issue #5578), matching by
        // accessibilityIdentifier even though the synthesized SDK owner's bounds
        // differ from the XCUITest snapshot.
        let owner = UIElementInfo(
            text: "Read the Terms of Service, contact Support, or review the Terms of Service again.",
            resourceId: "swiftui_semantic_links_inline",
            className: "CGDrawingView",
            bounds: ElementBounds(left: 16, top: 190, right: 382, bottom: 233)
        )
        let sdkOwner = SdkViewNode(
            className: "AccessibilityNode",
            bounds: SdkBounds(left: 17, top: 190, right: 383, bottom: 233),
            accessibilityIdentifier: "swiftui_semantic_links_inline",
            semanticLinks: [
                SdkSemanticLink(text: "Terms of Service", occurrence: 0, centerX: 156, centerY: 201),
                SdkSemanticLink(text: "Support", occurrence: 0, centerX: 321, centerY: 201),
                SdkSemanticLink(text: "Terms of Service", occurrence: 1, centerX: 168, centerY: 222),
            ]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: owner),
            sdk: makeSdkHierarchy(root: sdkOwner)
        )

        let links = result.hierarchy?.semanticLinks
        XCTAssertEqual(links?.count, 3)
        XCTAssertEqual(links?.map(\.text), ["Terms of Service", "Support", "Terms of Service"])
        XCTAssertEqual(links?.map(\.occurrence), [0, 0, 1])
        // SwiftUI links carry no range; the Android-parity wire shape keeps that nil.
        XCTAssertNil(links?[0].start)
        XCTAssertNil(links?[2].end)
    }

    func testDoesNotOverrideExistingXcuitestSemanticLinksWhenSdkHasNone() {
        // A standalone XCUITest link already carries a single-entry semanticLinks;
        // an SDK match without links must leave it intact.
        let standalone = UIElementInfo(
            resourceId: "uikit_semantic_links_standalone",
            className: "UITextView",
            bounds: ElementBounds(left: 0, top: 0, right: 200, bottom: 28),
            semanticLinks: [SemanticLink(text: "Privacy Policy", occurrence: 0)]
        )
        let sdkStandalone = SdkViewNode(
            className: "UITextView",
            bounds: SdkBounds(left: 0, top: 0, right: 200, bottom: 28),
            accessibilityIdentifier: "uikit_semantic_links_standalone",
            backgroundColor: "#00000000"
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: standalone),
            sdk: makeSdkHierarchy(root: sdkStandalone)
        )

        XCTAssertEqual(result.hierarchy?.semanticLinks?.map(\.text), ["Privacy Policy"])
    }

    func testIdentifierFallbackMatchesDifferentBounds() {
        // XCUITest and SDK have different bounds but same accessibilityIdentifier
        let xcuiWithId = UIElementInfo(
            resourceId: "layered-stack",
            className: "UIView",
            bounds: ElementBounds(left: 10, top: 100, right: 200, bottom: 300)
        )
        let sdkRoot = makeSdkNode(
            className: "_UIHostingView",
            bounds: SdkBounds(left: 15, top: 105, right: 205, bottom: 305),
            accessibilityIdentifier: "layered-stack",
            backgroundColor: "#0000FFFF",
            cornerRadius: 16.0
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiWithId),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let extras = result.hierarchy?.extras
        XCTAssertNotNil(extras, "Identifier fallback should match when bounds differ")
        XCTAssertEqual(extras?["sdk.backgroundColor"], "#0000FFFF")
        XCTAssertEqual(extras?["sdk.cornerRadius"], "16.0")
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

    // MARK: - SDK-Only Node Injection

    func testSdkOnlyNodeWithIdentifierInjected() {
        // XCUITest tree has a parent but is missing a child that the SDK tree has
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        // SDK tree has same parent + a child with an accessibilityIdentifier
        let sdkChild = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 10, top: 10, right: 100, bottom: 50),
            accessibilityIdentifier: "decorative-divider",
            backgroundColor: "#FF0000FF",
            cornerRadius: 4,
            children: nil
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkChild]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        // The injected child should appear as a child of the root
        let children = result.hierarchy?.node
        XCTAssertNotNil(children)
        XCTAssertEqual(children?.count, 1)

        let injected = children?.first
        XCTAssertEqual(injected?.className, "UIView")
        XCTAssertEqual(injected?.resourceId, "decorative-divider")
        XCTAssertEqual(injected?.extras?["sdk.source"], "sdkWalker")
        XCTAssertEqual(injected?.extras?["sdk.backgroundColor"], "#FF0000FF")
        XCTAssertEqual(injected?.extras?["sdk.cornerRadius"], "4.0")
    }

    func testSdkOnlyNodeWithCustomActionsInjected() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let sdkChild = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 100, right: 390, bottom: 200),
            accessibilityLabel: "Message from Alice",
            accessibilityCustomActions: ["Reply", "Forward", "Delete"]
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkChild]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let injected = result.hierarchy?.node?.first
        XCTAssertNotNil(injected)
        XCTAssertEqual(injected?.text, "Message from Alice")
        XCTAssertEqual(injected?.extras?["sdk.accessibilityCustomActions"], "Reply,Forward,Delete")
        XCTAssertEqual(injected?.extras?["sdk.source"], "sdkWalker")
    }

    func testSdkOnlyNodeWithA11yHiddenInjected() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let sdkChild = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 10, top: 50, right: 200, bottom: 80),
            accessibilityLabel: "Hidden helper text",
            accessibilityElementsHidden: true
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkChild]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let injected = result.hierarchy?.node?.first
        XCTAssertNotNil(injected)
        XCTAssertEqual(injected?.className, "UILabel")
        XCTAssertEqual(injected?.text, "Hidden helper text")
        XCTAssertEqual(injected?.extras?["sdk.accessibilityElementsHidden"], "true")
        XCTAssertEqual(injected?.extras?["sdk.source"], "sdkWalker")
    }

    func testMatchedSdkNodeNotDuplicatedAsInjection() {
        // Both trees have the same child — it should be enriched, not injected
        let xcuiChild = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 50, right: 200, bottom: 80),
            text: "Hello"
        )
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [xcuiChild]
        )
        let sdkChild = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 10, top: 50, right: 200, bottom: 80),
            accessibilityTraits: ["staticText"]
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkChild]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        // Should still be exactly 1 child (enriched, not duplicated)
        XCTAssertEqual(result.hierarchy?.node?.count, 1)
        let child = result.hierarchy?.node?.first
        XCTAssertEqual(child?.text, "Hello")
        XCTAssertEqual(child?.extras?["sdk.accessibilityTraits"], "staticText")
        XCTAssertNil(child?.extras?["sdk.source"]) // Not injected, just enriched
    }

    func testStructuralOnlyNodeNotInjected() {
        // SDK child has no identifier, label, actions, or visual properties — skip it
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let sdkChild = makeSdkNode(
            className: "UITransitionView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkChild]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        // Structural-only node should not be injected
        XCTAssertNil(result.hierarchy?.node)
    }

    func testNestedSdkOnlyChildrenInjected() {
        // SDK-only parent with a meaningful child — both should be injected
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let sdkGrandchild = makeSdkNode(
            className: "UIImageView",
            bounds: SdkBounds(left: 20, top: 20, right: 60, bottom: 60),
            accessibilityIdentifier: "nested-icon"
        )
        let sdkChild = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 10, top: 10, right: 100, bottom: 100),
            accessibilityIdentifier: "nested-container",
            children: [sdkGrandchild]
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkChild]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let injectedParent = result.hierarchy?.node?.first
        XCTAssertNotNil(injectedParent)
        XCTAssertEqual(injectedParent?.resourceId, "nested-container")
        XCTAssertEqual(injectedParent?.extras?["sdk.source"], "sdkWalker")

        let injectedChild = injectedParent?.node?.first
        XCTAssertNotNil(injectedChild)
        XCTAssertEqual(injectedChild?.resourceId, "nested-icon")
        XCTAssertEqual(injectedChild?.extras?["sdk.source"], "sdkWalker")
    }

    func testInjectedNodePreservesExistingChildren() {
        // XCUITest parent has existing children; SDK-only nodes should be appended
        let xcuiChild = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 10, right: 200, bottom: 40),
            text: "Existing"
        )
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [xcuiChild]
        )
        let sdkExisting = makeSdkNode(
            className: "UILabel",
            bounds: SdkBounds(left: 10, top: 10, right: 200, bottom: 40)
        )
        let sdkNew = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 10, top: 50, right: 200, bottom: 100),
            accessibilityIdentifier: "sdk-only-view",
            backgroundColor: "#00FF00FF"
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [sdkExisting, sdkNew]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let children = result.hierarchy?.node
        XCTAssertEqual(children?.count, 2)
        XCTAssertEqual(children?[0].text, "Existing")
        XCTAssertNil(children?[0].extras?["sdk.source"])
        XCTAssertEqual(children?[1].resourceId, "sdk-only-view")
        XCTAssertEqual(children?[1].extras?["sdk.source"], "sdkWalker")
    }

    func testSdkOnlyChildrenAreNotDuplicatedUnderContainmentMatches() {
        let xcuiChildren = (0 ..< 3).map { index in
            makeElement(
                className: "ListCollectionViewCell",
                bounds: ElementBounds(left: 0, top: 100 + index * 60, right: 390, bottom: 150 + index * 60),
                text: "Cell \(index)"
            )
        }
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: xcuiChildren
        )
        let tabLabels: [String] = ["Discover", "Demos", "Settings"]
        let sdkTabLabels = tabLabels.enumerated().map { index, label in
            makeSdkNode(
                className: "UITabBarButtonLabel",
                bounds: SdkBounds(left: 20 + index * 120, top: 760, right: 120 + index * 120, bottom: 790),
                accessibilityLabel: label,
                accessibilityIdentifier: "sdk-only-tab-label-\(label)",
                isAccessibilityElement: true
            )
        }
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: sdkTabLabels
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        XCTAssertEqual(
            countResourceId("sdk-only-tab-label-Discover", in: result.hierarchy),
            1,
            "SDK-only children should be injected once under the direct parent, not repeated under each contained XCUITest cell"
        )
        XCTAssertEqual(countClassName("UITabBarButtonLabel", in: result.hierarchy), 3)
        XCTAssertEqual(countText("Discover", in: result.hierarchy), 1)
        XCTAssertEqual(countText("Demos", in: result.hierarchy), 1)
        XCTAssertEqual(countText("Settings", in: result.hierarchy), 1)
        XCTAssertEqual(countNodes(in: result.hierarchy), 7)
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

    // MARK: - Scale reporting metadata (#4548)

    func testScaleReportingMetadataPreservedThroughFullMerge() {
        // Full-merge path: sdk has a root, so HierarchyMerger reconstructs the ViewHierarchy
        // and must carry the additive scale metadata through (iPhone Plus values: scale 3.0
        // differs from nativeScale 2.608696, so a scale/nativeScale mix-up fails here).
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: makeElement(),
            screenScale: 3.0,
            screenWidth: 414,
            screenHeight: 736,
            nativeScale: 2.608696,
            pixelWidth: 1080,
            pixelHeight: 1920
        )
        let sdk = makeSdkHierarchy(root: makeSdkNode())

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdk)

        XCTAssertEqual(result.screenScale, 3.0)
        XCTAssertEqual(result.nativeScale, 2.608696)
        XCTAssertEqual(result.pixelWidth, 1080)
        XCTAssertEqual(result.pixelHeight, 1920)
    }

    func testScaleReportingMetadataPreservedWhenSdkHasNoRoot() {
        // Rootless-sdk path: the merger still reconstructs the ViewHierarchy (for insets
        // enrichment) and must not drop the scale metadata.
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: makeElement(),
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            nativeScale: 3.144,
            pixelWidth: 1179,
            pixelHeight: 2553
        )
        let sdk = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdk)

        XCTAssertEqual(result.nativeScale, 3.144)
        XCTAssertEqual(result.pixelWidth, 1179)
        XCTAssertEqual(result.pixelHeight, 2553)
    }

    // MARK: - Layer-only Nodes (SwiftUI shapes via CALayer)

    func testLayerNodeBorderAndLayerFlagSurfaceInExtras() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 95, top: 202, right: 295, bottom: 402)
        )
        let layerNode = SdkViewNode(
            className: "CAShapeLayer",
            bounds: SdkBounds(left: 95, top: 202, right: 295, bottom: 402),
            alpha: 0.7,
            backgroundColor: "#FF000080",
            cornerRadius: 20,
            borderColor: "#00FF00FF",
            borderWidth: 2,
            isLayerNode: true
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: layerNode)
        )

        let extras = result.hierarchy?.extras
        XCTAssertEqual(extras?["sdk.backgroundColor"], "#FF000080")
        XCTAssertEqual(extras?["sdk.cornerRadius"], "20.0")
        XCTAssertEqual(extras?["sdk.borderColor"], "#00FF00FF")
        XCTAssertEqual(extras?["sdk.borderWidth"], "2.0")
        XCTAssertEqual(extras?["sdk.isLayerNode"], "true")
    }

    func testLayerOnlyChildInjectedWhenAbsentFromXcuitest() {
        // XCUITest sees only the container; SDK walker reports a CALayer shape child.
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let shapeLayer = SdkViewNode(
            className: "CAShapeLayer",
            bounds: SdkBounds(left: 95, top: 202, right: 295, bottom: 402),
            backgroundColor: "#FF000080",
            cornerRadius: 20,
            isLayerNode: true
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [shapeLayer]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let injected = result.hierarchy?.node?.first
        XCTAssertNotNil(injected, "Layer-only shape should be injected as a child")
        XCTAssertEqual(injected?.className, "CAShapeLayer")
        XCTAssertEqual(injected?.extras?["sdk.source"], "sdkWalker")
        XCTAssertEqual(injected?.extras?["sdk.isLayerNode"], "true")
        XCTAssertEqual(injected?.extras?["sdk.backgroundColor"], "#FF000080")
        XCTAssertEqual(injected?.extras?["sdk.cornerRadius"], "20.0")
    }

    // MARK: - Single match pass (#5475)

    /// The XCUITest tree is matched against the SDK tree exactly once — one match
    /// resolution per node — rather than the three passes (enrich, collect, inject)
    /// the pre-#5475 implementation performed.
    func testTreeIsMatchedExactlyOncePerNode() {
        let grandchild = makeElement(
            className: "UILabel",
            bounds: ElementBounds(left: 10, top: 60, right: 200, bottom: 90),
            text: "Leaf"
        )
        let child = makeElement(
            className: "UIStackView",
            bounds: ElementBounds(left: 0, top: 50, right: 375, bottom: 200),
            children: [grandchild]
        )
        let root = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
            children: [child]
        )
        // 3 XCUITest nodes total.

        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 812),
            children: [
                makeSdkNode(
                    className: "UILabel",
                    bounds: SdkBounds(left: 10, top: 60, right: 200, bottom: 90),
                    accessibilityTraits: ["staticText"]
                ),
            ]
        )

        let counter = HierarchyMerger.MatchCounter()
        _ = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: root),
            sdk: makeSdkHierarchy(root: sdkRoot),
            matchCounter: counter
        )

        XCTAssertEqual(counter.count, 3, "Each XCUITest node should be matched exactly once")
    }

    /// A matched SDK node whose fields are all at their defaults contributes no
    /// `sdk.*` keys, so a node with no prior extras yields no extras dictionary.
    func testDefaultValuedSdkMatchYieldsNoExtras() {
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 100)
        )
        // All-default SDK node (alpha 1.0, isAccessibilityElement false,
        // hasTapTarget false, isUserInteractionEnabled true, no visual props).
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100)
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        XCTAssertNil(result.hierarchy?.extras, "Default-valued SDK match should add no extras")
    }

    func testLayerNodeBorderOnlyIsWorthInjecting() {
        // Verifies isWorthInjecting treats border-only nodes as meaningful.
        let xcuiRoot = makeElement(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 0, right: 390, bottom: 844)
        )
        let borderOnly = SdkViewNode(
            className: "CALayer",
            bounds: SdkBounds(left: 50, top: 50, right: 150, bottom: 150),
            borderColor: "#123456FF",
            borderWidth: 1,
            isLayerNode: true
        )
        let sdkRoot = makeSdkNode(
            className: "UIView",
            bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
            children: [borderOnly]
        )

        let result = HierarchyMerger.merge(
            xcuitest: makeHierarchy(root: xcuiRoot),
            sdk: makeSdkHierarchy(root: sdkRoot)
        )

        let injected = result.hierarchy?.node?.first
        XCTAssertNotNil(injected)
        XCTAssertEqual(injected?.extras?["sdk.borderColor"], "#123456FF")
        XCTAssertEqual(injected?.extras?["sdk.borderWidth"], "1.0")
    }
}
