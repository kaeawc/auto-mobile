import CtrlProxyRewrite
import XCTest

/// Replays captured iOS 27 Playground observations through `HierarchyMerger` (#10851).
///
/// The captures are merged runner output, so each one is converted back into the two
/// runner inputs: the XCUITest tree is the capture minus every `sdk.source=sdkWalker`
/// subtree (and minus the `sdk.*` extras the merge added), and the SDK tree mirrors
/// that XCUITest skeleton with the captured SDK-only subtrees re-attached under the SDK
/// node they were injected from. When a captured SDK-only node carries the id of the
/// XCUITest node that received an injection (the stale `HostingScrollView` page copy),
/// the injected children go back under that SDK node, as they were in the app.
final class HierarchyMergerCapturedFixtureTests: XCTestCase {
    func testSemanticLinksPageCopyIsNotInjectedBesideTheXcuitestScrollView() throws {
        let merged = try replay("ios27-uikit-semantic-links-sdk-owner-duplicate.json")
        let injected = flatten(merged).filter(isInjected)

        XCTAssertFalse(injected.contains { $0.className == "HostingScrollView" })
        XCTAssertFalse(injected.contains { $0.resourceId?.hasPrefix("uikit_semantic_links_") == true })
        try assertNoInjectedCopyOfAnXcuitestIdentifier(merged)
    }

    func testKeyboardShiftedStaleSnapshotDoesNotInjectMovedCartCopies() throws {
        let merged = try replay("nested-selection/cart-a-item-42-focused-keyboard-shift.json")
        let nodes = flatten(merged)

        XCTAssertFalse(nodes.contains { isInjected($0) && ["cart_A", "cart_B", "quantity"].contains($0.resourceId) })
        for cart in ["cart_A", "cart_B"] {
            let xcuitestCart = try XCTUnwrap(nodes.first { $0.resourceId == cart && !isInjected($0) })
            XCTAssertFalse((xcuitestCart.node ?? []).contains(where: isInjected), cart)
        }
        try assertNoInjectedCopyOfAnXcuitestIdentifier(merged)
    }

    func testBeforeFocusTapCapture() throws {
        try assertReplayKeepsXcuitestAndInjectsNoCopies("nested-selection/cart-a-item-42-before-focus-tap.json")
    }

    func testCartAItem44FocusedCapture() throws {
        try assertReplayKeepsXcuitestAndInjectsNoCopies("nested-selection/cart-a-item-44-quantity-focused.json")
    }

    func testCartBItem41FocusedCapture() throws {
        try assertReplayKeepsXcuitestAndInjectsNoCopies("nested-selection/cart-b-item-41-quantity-focused.json")
    }

    func testDuplicateContainerIdCapture() throws {
        try assertReplayKeepsXcuitestAndInjectsNoCopies("nested-selection/scroll-cart-duplicate-container-id.json")
    }

    // MARK: - Helpers

    private func assertReplayKeepsXcuitestAndInjectsNoCopies(
        _ fixture: String,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        throws
    {
        let capture = try CapturedFixture(named: fixture)
        let merged = HierarchyMerger.merge(xcuitest: capture.xcuitest, sdk: capture.sdk).hierarchy
        XCTAssertEqual(
            flatten(merged).filter { !isInjected($0) }.map(\.className),
            flatten(capture.xcuitest.hierarchy).map(\.className),
            "XCUITest nodes must survive the merge unchanged",
            file: file,
            line: line
        )
        try assertNoInjectedCopyOfAnXcuitestIdentifier(merged, file: file, line: line)
    }

    /// The replayed SDK snapshot predates the capture, so no injected node may carry an
    /// identifier that an XCUITest node carries: within the tolerance it is that node's
    /// counterpart, and anywhere else it is a stale copy.
    private func assertNoInjectedCopyOfAnXcuitestIdentifier(
        _ merged: UIElementInfo?,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        throws
    {
        let nodes = flatten(merged)
        let xcuitestIds = Set(nodes.filter { !isInjected($0) }.compactMap(\.resourceId).filter { !$0.isEmpty })
        let copies = nodes.filter { isInjected($0) && xcuitestIds.contains($0.resourceId ?? "") }
        XCTAssertEqual(
            copies.map { "\($0.className ?? "?") \($0.resourceId ?? "")" },
            [],
            file: file,
            line: line
        )
    }

    private func replay(_ fixture: String) throws -> UIElementInfo? {
        let capture = try CapturedFixture(named: fixture)
        return HierarchyMerger.merge(xcuitest: capture.xcuitest, sdk: capture.sdk).hierarchy
    }

    private func isInjected(_ node: UIElementInfo) -> Bool {
        node.extras?["sdk.source"] == "sdkWalker"
    }

    private func flatten(_ root: UIElementInfo?) -> [UIElementInfo] {
        guard let root else { return [] }
        return [root] + (root.node ?? []).flatMap { flatten($0) }
    }
}

/// One captured observation converted back into the runner's merge inputs.
private struct CapturedFixture {
    let xcuitest: ViewHierarchy
    let sdk: SdkViewHierarchy

    init(named name: String) throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // CtrlProxyRewriteTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // control-proxy
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("test/fixtures/ios/\(name)")
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
            name
        )
        let observation = (json["viewHierarchy"] as? [String: Any]) ?? json
        let rootJSON = try XCTUnwrap(observation["hierarchy"] as? [String: Any], name)
        let updatedAt = try XCTUnwrap((observation["updatedAt"] ?? json["updatedAt"]) as? NSNumber, name).int64Value
        let root = try CapturedNode(rootJSON)
        root.reattachInjectedChildren(capturedSdk: root.sdkNodesInDocumentOrder())

        xcuitest = ViewHierarchy(
            updatedAt: updatedAt,
            packageName: "dev.jasonpearson.automobile.playground",
            hierarchy: root.xcuitestElement()
        )
        // The cached SDK snapshot the runner merged predates the XCUITest capture.
        sdk = SdkViewHierarchy(
            timestamp: updatedAt - 1, bundleId: "dev.jasonpearson.automobile.playground", screenScale: 3,
            screenWidth: 402, screenHeight: 874, root: root.sdkMirror()
        )
    }
}

private final class CapturedNode {
    let className: String
    let bounds: [Int]
    let identifier: String?
    let text: String?
    let extras: [String: String]
    let isSdk: Bool
    var children: [CapturedNode]
    /// Captured SDK-only children that were injected under this XCUITest node.
    var injected: [CapturedNode] = []

    init(_ json: [String: Any]) throws {
        className = try XCTUnwrap(json["className"] as? String)
        bounds = try XCTUnwrap(json["bounds"] as? [Int])
        identifier = json["resource-id"] as? String
        text = json["text"] as? String
        extras = (json["extras"] as? [String: String]) ?? [:]
        isSdk = extras["sdk.source"] == "sdkWalker"
        let rawChildren: [[String: Any]] =
            if let list = json["node"] as? [[String: Any]] {
                list
            } else if let single = json["node"] as? [String: Any] {
                [single]
            } else {
                []
            }
        let parsed = try rawChildren.map { try CapturedNode($0) }
        if isSdk {
            children = parsed
        } else {
            children = parsed.filter { !$0.isSdk }
            injected = parsed.filter(\.isSdk)
        }
    }

    func sdkNodesInDocumentOrder() -> [CapturedNode] {
        (isSdk ? [self] : []) + (children + injected).flatMap { $0.sdkNodesInDocumentOrder() }
    }

    /// Move each XCUITest node's injected children back under a childless captured
    /// SDK node with the same identifier, when one exists (the SDK node they came from).
    func reattachInjectedChildren(capturedSdk: [CapturedNode]) {
        if !isSdk, !injected.isEmpty, let identifier, !identifier.isEmpty,
           let source = capturedSdk.first(where: {
               $0.identifier == identifier && $0.children.isEmpty && !$0.isDescendant(ofAny: injected)
           })
        {
            source.children = injected
            injected = []
        }
        for child in children where !child.isSdk {
            child.reattachInjectedChildren(capturedSdk: capturedSdk)
        }
    }

    private func isDescendant(ofAny roots: [CapturedNode]) -> Bool {
        roots.contains { root in root === self || root.children.contains { self.isDescendant(ofAny: [$0]) } }
    }

    func xcuitestElement() -> UIElementInfo {
        let ownExtras = extras.filter { !$0.key.hasPrefix("sdk.") }
        let xcChildren = children.map { $0.xcuitestElement() }
        return UIElementInfo(
            text: text,
            resourceId: identifier,
            className: className,
            bounds: elementBounds,
            extras: ownExtras.isEmpty ? nil : ownExtras,
            node: xcChildren.isEmpty ? nil : xcChildren
        )
    }

    func sdkMirror() -> SdkViewNode {
        let mirrored = (children + injected).map { $0.sdkMirror() }
        return SdkViewNode(
            className: className,
            bounds: SdkBounds(left: bounds[0], top: bounds[1], right: bounds[2], bottom: bounds[3]),
            accessibilityLabel: text,
            accessibilityIdentifier: identifier,
            isAccessibilityElement: extras["sdk.isAccessibilityElement"] == "true",
            accessibilityTraits: extras["sdk.accessibilityTraits"]?.split(separator: ",").map(String.init) ?? [],
            backgroundColor: extras["sdk.backgroundColor"],
            cornerRadius: extras["sdk.cornerRadius"].flatMap(Float.init) ?? 0,
            borderColor: extras["sdk.borderColor"],
            borderWidth: extras["sdk.borderWidth"].flatMap(Float.init) ?? 0,
            isLayerNode: extras["sdk.isLayerNode"] == "true",
            hasTapTarget: extras["sdk.hasTapTarget"] == "true",
            children: mirrored.isEmpty ? nil : mirrored
        )
    }

    private var elementBounds: ElementBounds {
        ElementBounds(left: bounds[0], top: bounds[1], right: bounds[2], bottom: bounds[3])
    }
}
