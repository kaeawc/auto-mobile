import Foundation

/// Merges XCUITest-based `ViewHierarchy` with SDK's in-process `SdkViewHierarchy`,
/// populating the `extras` field on each `UIElementInfo` node with `sdk.*` keys.
///
/// If no SDK hierarchy is available, returns the XCUITest hierarchy unchanged.
public enum HierarchyMerger {

    /// Tolerance in points for bounds matching between XCUITest and SDK nodes.
    private static let boundsTolerance = 2

    /// Merge SDK hierarchy data into the XCUITest hierarchy.
    ///
    /// Two-pass merge:
    /// 1. **Enrich** — annotate existing XCUITest nodes with `sdk.*` extras from matched SDK nodes.
    /// 2. **Inject** — add SDK-only nodes (views absent from the XCUITest tree) as children
    ///    of their nearest matched parent. Injected nodes carry `sdk.source=sdkWalker`.
    public static func merge(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy?) -> ViewHierarchy {
        guard let sdk else { return xcuitest }
        let safeArea = sdk.safeAreaInsets.map {
            EdgeInsetsInfo(top: $0.top, right: $0.right, bottom: $0.bottom, left: $0.left)
        }
        let enrichedInsets = safeArea.map {
            ObservationInsetsInfo(available: true, source: "ios-sdk-safe-area", units: "points", safeArea: $0)
        } ?? xcuitest.insets
        guard let sdkRoot = sdk.root else {
            return ViewHierarchy(
                updatedAt: xcuitest.updatedAt,
                packageName: xcuitest.packageName,
                hierarchy: xcuitest.hierarchy,
                windowInfo: xcuitest.windowInfo,
                windows: xcuitest.windows,
                screenScale: xcuitest.screenScale,
                screenWidth: xcuitest.screenWidth,
                screenHeight: xcuitest.screenHeight,
                systemInsets: safeArea ?? xcuitest.systemInsets,
                insets: enrichedInsets,
                error: xcuitest.error,
                fallbackToSpringboard: xcuitest.fallbackToSpringboard
            )
        }
        guard let xcuitestRoot = xcuitest.hierarchy else { return xcuitest }

        // Build flat lookups from the SDK tree
        var lookup: [LookupKey: SdkViewNode] = [:]
        var boundsLookup: [BoundsKey: SdkViewNode] = [:]
        var identifierLookup: [String: SdkViewNode] = [:]
        var allSdkNodes: [SdkViewNode] = []
        buildLookup(node: sdkRoot, into: &lookup, boundsLookup: &boundsLookup, identifierLookup: &identifierLookup, allNodes: &allSdkNodes)

        // Pass 1: enrich existing XCUITest nodes with SDK extras
        let enrichedRoot = enrichNode(xcuitestRoot, lookup: lookup, boundsLookup: boundsLookup, identifierLookup: identifierLookup, allSdkNodes: allSdkNodes)

        // Collect a counted bag of SDK keys that matched an XCUITest node.
        // Using counts (not a set) so identical-keyed siblings aren't collapsed.
        var matchedSdkKeyCounts: [LookupKey: Int] = [:]
        collectMatchedKeys(element: xcuitestRoot, lookup: lookup, boundsLookup: boundsLookup, identifierLookup: identifierLookup, allSdkNodes: allSdkNodes, matched: &matchedSdkKeyCounts)

        // Pass 2: inject SDK-only nodes as children of directly matched parents.
        var injectedParentKeys = Set<LookupKey>()
        let rootSdkNode = findDirectMatch(
            className: xcuitestRoot.className,
            resourceId: xcuitestRoot.resourceId,
            bounds: xcuitestRoot.bounds,
            in: lookup,
            boundsLookup: boundsLookup,
            identifierLookup: identifierLookup
        )
        let injectedRoot = injectSdkOnlyNodes(
            element: enrichedRoot,
            sdkNode: rootSdkNode,
            lookup: lookup,
            boundsLookup: boundsLookup,
            identifierLookup: identifierLookup,
            matchedSdkKeyCounts: matchedSdkKeyCounts,
            injectedParentKeys: &injectedParentKeys
        )

        return ViewHierarchy(
            updatedAt: xcuitest.updatedAt,
            packageName: xcuitest.packageName,
            hierarchy: injectedRoot,
            windowInfo: xcuitest.windowInfo,
            windows: xcuitest.windows,
            screenScale: xcuitest.screenScale,
            screenWidth: xcuitest.screenWidth,
            screenHeight: xcuitest.screenHeight,
            systemInsets: safeArea ?? xcuitest.systemInsets,
            insets: enrichedInsets,
            error: xcuitest.error,
            fallbackToSpringboard: xcuitest.fallbackToSpringboard
        )
    }

    // MARK: - Lookup

    private struct LookupKey: Hashable {
        let className: String
        let left: Int
        let top: Int
        let right: Int
        let bottom: Int
    }

    /// Bounds-only key for fallback matching when class names differ
    /// (e.g. XCUITest "UIView" vs SDK "_UIHostingView").
    private struct BoundsKey: Hashable {
        let left: Int
        let top: Int
        let right: Int
        let bottom: Int
    }

    private static func buildLookup(
        node: SdkViewNode,
        into lookup: inout [LookupKey: SdkViewNode],
        boundsLookup: inout [BoundsKey: SdkViewNode],
        identifierLookup: inout [String: SdkViewNode],
        allNodes: inout [SdkViewNode]
    ) {
        allNodes.append(node)
        // Index by exact bounds only (one insert per node). Tolerance matching is
        // done at lookup time by probing the query's ±tol neighborhood (see
        // findDirectMatch) instead of pre-expanding every node into (2*tol+1)^4
        // dictionary entries, which was ~625 inserts per node at tol=2 (issue #3634).
        let key = LookupKey(
            className: node.className,
            left: node.bounds.left, top: node.bounds.top,
            right: node.bounds.right, bottom: node.bounds.bottom
        )
        if lookup[key] == nil {
            lookup[key] = node
        }
        let bKey = BoundsKey(
            left: node.bounds.left, top: node.bounds.top,
            right: node.bounds.right, bottom: node.bounds.bottom
        )
        if boundsLookup[bKey] == nil {
            boundsLookup[bKey] = node
        }
        // Index by accessibilityIdentifier for fallback when bounds don't match
        if let identifier = node.accessibilityIdentifier, !identifier.isEmpty {
            if identifierLookup[identifier] == nil {
                identifierLookup[identifier] = node
            }
        }
        if let children = node.children {
            for child in children {
                buildLookup(node: child, into: &lookup, boundsLookup: &boundsLookup, identifierLookup: &identifierLookup, allNodes: &allNodes)
            }
        }
    }

    // MARK: - Matching

    /// Find a matching SDK node for an XCUITest element.
    /// Strategy: (1) exact className+bounds, (2) bounds-only, (3) accessibilityIdentifier,
    /// (4) smallest enclosing SDK node (for SwiftUI views where accessibility bounds differ from UIKit).
    private static func findMatch(
        className: String?,
        resourceId: String?,
        bounds: ElementBounds?,
        in lookup: [LookupKey: SdkViewNode],
        boundsLookup: [BoundsKey: SdkViewNode],
        identifierLookup: [String: SdkViewNode],
        allSdkNodes: [SdkViewNode]
    ) -> SdkViewNode? {
        if let direct = findDirectMatch(
            className: className,
            resourceId: resourceId,
            bounds: bounds,
            in: lookup,
            boundsLookup: boundsLookup,
            identifierLookup: identifierLookup
        ) {
            return direct
        }
        // 4. Smallest enclosing SDK node: find the SDK node with smallest area
        //    that fully contains this element's bounds.
        if let bounds = bounds {
            let tol = boundsTolerance
            var bestNode: SdkViewNode?
            var bestArea = Int.max
            for node in allSdkNodes {
                let nb = node.bounds
                // Check containment with tolerance
                if nb.left - tol <= bounds.left &&
                   nb.top - tol <= bounds.top &&
                   nb.right + tol >= bounds.right &&
                   nb.bottom + tol >= bounds.bottom {
                    let area = nb.width * nb.height
                    if area < bestArea {
                        bestArea = area
                        bestNode = node
                    }
                }
            }
            return bestNode
        }
        return nil
    }

    /// Find a direct SDK counterpart for an XCUITest element.
    /// Direct matches are safe to use for SDK-only injection placement; containment
    /// matches are enrichment-only because broad containers can match many descendants.
    private static func findDirectMatch(
        className: String?,
        resourceId: String?,
        bounds: ElementBounds?,
        in lookup: [LookupKey: SdkViewNode],
        boundsLookup: [BoundsKey: SdkViewNode],
        identifierLookup: [String: SdkViewNode]
    ) -> SdkViewNode? {
        if let bounds = bounds {
            // 1. className + bounds, exact then within ±tolerance.
            if let className = className {
                if let exact = lookup[LookupKey(
                    className: className,
                    left: bounds.left, top: bounds.top,
                    right: bounds.right, bottom: bounds.bottom
                )] {
                    return exact
                }
                if let near = probeToleranceMatch(bounds: bounds, in: lookup, makeKey: { l, t, r, b in
                    LookupKey(className: className, left: l, top: t, right: r, bottom: b)
                }) {
                    return near
                }
            }
            // 2. Bounds-only fallback: different class names at the same position,
            //    exact then within ±tolerance.
            if let boundsMatch = boundsLookup[BoundsKey(
                left: bounds.left, top: bounds.top,
                right: bounds.right, bottom: bounds.bottom
            )] {
                return boundsMatch
            }
            if let near = probeToleranceMatch(bounds: bounds, in: boundsLookup, makeKey: { l, t, r, b in
                BoundsKey(left: l, top: t, right: r, bottom: b)
            }) {
                return near
            }
        }
        // 3. Identifier fallback: match by accessibilityIdentifier when bounds differ
        if let resourceId = resourceId, !resourceId.isEmpty {
            if let idMatch = identifierLookup[resourceId] {
                return idMatch
            }
        }
        return nil
    }

    /// Probe the ±`boundsTolerance` neighborhood of `bounds` against an exact-bounds
    /// index, returning the first hit. Replaces the old per-node pre-expansion:
    /// a node with exact bounds within ±tol of the query is found here because
    /// `node.bounds == query + delta` for some `delta ∈ [-tol, tol]` (issue #3634).
    /// The exact (all-zero) offset is skipped because callers check it first.
    private static func probeToleranceMatch<Key: Hashable>(
        bounds: ElementBounds,
        in index: [Key: SdkViewNode],
        makeKey: (_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> Key
    ) -> SdkViewNode? {
        let tol = boundsTolerance
        for dl in -tol...tol {
            for dt in -tol...tol {
                for dr in -tol...tol {
                    for db in -tol...tol {
                        if dl == 0, dt == 0, dr == 0, db == 0 { continue }
                        let key = makeKey(
                            bounds.left + dl, bounds.top + dt,
                            bounds.right + dr, bounds.bottom + db
                        )
                        if let hit = index[key] {
                            return hit
                        }
                    }
                }
            }
        }
        return nil
    }

    // MARK: - Enrichment

    private static func enrichNode(_ element: UIElementInfo, lookup: [LookupKey: SdkViewNode], boundsLookup: [BoundsKey: SdkViewNode], identifierLookup: [String: SdkViewNode], allSdkNodes: [SdkViewNode]) -> UIElementInfo {
        let sdkNode = findMatch(className: element.className, resourceId: element.resourceId, bounds: element.bounds, in: lookup, boundsLookup: boundsLookup, identifierLookup: identifierLookup, allSdkNodes: allSdkNodes)
        let enrichedExtras = buildExtras(existing: element.extras, sdkNode: sdkNode)

        let enrichedChildren: [UIElementInfo]? = element.node?.map { enrichNode($0, lookup: lookup, boundsLookup: boundsLookup, identifierLookup: identifierLookup, allSdkNodes: allSdkNodes) }

        return UIElementInfo(
            text: element.text,
            value: element.value,
            textSize: element.textSize,
            contentDesc: element.contentDesc,
            resourceId: element.resourceId,
            className: element.className,
            bounds: element.bounds,
            clickable: element.clickable,
            enabled: element.enabled,
            focusable: element.focusable,
            focused: element.focused,
            // XCUITest cannot observe the VoiceOver cursor, so this flag only ever
            // arrives from the matched in-app SDK node; fall back to the existing
            // value when there is no SDK match. Follows the "true"-or-nil
            // convention used for the other boolean attributes (#3924).
            accessibilityFocused: sdkNode?.isAccessibilityFocused == true ? "true" : element.accessibilityFocused,
            scrollable: element.scrollable,
            password: element.password,
            checkable: element.checkable,
            checked: element.checked,
            selected: element.selected,
            longClickable: element.longClickable,
            testTag: element.testTag,
            role: element.role,
            stateDescription: element.stateDescription,
            errorMessage: element.errorMessage,
            hintText: element.hintText,
            viewId: element.viewId,
            extras: enrichedExtras,
            actions: element.actions,
            node: enrichedChildren
        )
    }

    private static func buildExtras(existing: [String: String]?, sdkNode: SdkViewNode?) -> [String: String]? {
        guard let node = sdkNode else { return existing }

        var extras = existing ?? [:]

        if !node.accessibilityTraits.isEmpty {
            extras["sdk.accessibilityTraits"] = node.accessibilityTraits.joined(separator: ",")
        }
        if !node.accessibilityCustomActions.isEmpty {
            extras["sdk.accessibilityCustomActions"] = node.accessibilityCustomActions.joined(separator: ",")
        }
        if !node.gestureRecognizers.isEmpty {
            let gestures = node.gestureRecognizers.map { "\($0.type)(\($0.isEnabled ? "enabled" : "disabled"))" }
            extras["sdk.gestureRecognizers"] = gestures.joined(separator: ",")
        }
        if let bg = node.backgroundColor {
            extras["sdk.backgroundColor"] = bg
        }
        extras["sdk.alpha"] = String(node.alpha)
        if node.cornerRadius > 0 {
            extras["sdk.cornerRadius"] = String(node.cornerRadius)
        }
        if let borderColor = node.borderColor {
            extras["sdk.borderColor"] = borderColor
        }
        if node.borderWidth > 0 {
            extras["sdk.borderWidth"] = String(node.borderWidth)
        }
        if node.isLayerNode {
            extras["sdk.isLayerNode"] = "true"
        }
        extras["sdk.isAccessibilityElement"] = String(node.isAccessibilityElement)
        if node.accessibilityElementsHidden {
            extras["sdk.accessibilityElementsHidden"] = "true"
        }
        extras["sdk.hasTapTarget"] = String(node.hasTapTarget)
        if node.isOccluded {
            extras["sdk.isOccluded"] = "true"
        }
        extras["sdk.isUserInteractionEnabled"] = String(node.isUserInteractionEnabled)

        return extras.isEmpty ? nil : extras
    }

    // MARK: - Pass 2: SDK-Only Node Injection

    /// Collect the exact lookup keys for SDK nodes that matched an XCUITest node.
    /// Uses a counted bag so identical-keyed siblings each get their own match slot.
    private static func collectMatchedKeys(
        element: UIElementInfo,
        lookup: [LookupKey: SdkViewNode],
        boundsLookup: [BoundsKey: SdkViewNode],
        identifierLookup: [String: SdkViewNode],
        allSdkNodes: [SdkViewNode],
        matched: inout [LookupKey: Int]
    ) {
        if let sdkNode = findMatch(className: element.className, resourceId: element.resourceId, bounds: element.bounds, in: lookup, boundsLookup: boundsLookup, identifierLookup: identifierLookup, allSdkNodes: allSdkNodes) {
            let key = exactKey(for: sdkNode)
            matched[key, default: 0] += 1
        }
        if let children = element.node {
            for child in children {
                collectMatchedKeys(element: child, lookup: lookup, boundsLookup: boundsLookup, identifierLookup: identifierLookup, allSdkNodes: allSdkNodes, matched: &matched)
            }
        }
    }

    /// Walk the enriched XCUITest tree alongside the SDK tree.
    /// For each XCUITest node that matched an SDK node, check the SDK node's children —
    /// any SDK child that didn't match an XCUITest node gets injected.
    private static func injectSdkOnlyNodes(
        element: UIElementInfo,
        sdkNode: SdkViewNode?,
        lookup: [LookupKey: SdkViewNode],
        boundsLookup: [BoundsKey: SdkViewNode],
        identifierLookup: [String: SdkViewNode],
        matchedSdkKeyCounts: [LookupKey: Int],
        injectedParentKeys: inout Set<LookupKey>
    ) -> UIElementInfo {
        // Find the SDK node that corresponds to this XCUITest element
        let currentSdk = sdkNode ?? findDirectMatch(
            className: element.className,
            resourceId: element.resourceId,
            bounds: element.bounds,
            in: lookup,
            boundsLookup: boundsLookup,
            identifierLookup: identifierLookup
        )

        // Recurse into existing children, pairing each with its SDK counterpart
        let processedChildren: [UIElementInfo]?
        if let children = element.node {
            processedChildren = children.map { child in
                let childSdk = findDirectMatch(
                    className: child.className,
                    resourceId: child.resourceId,
                    bounds: child.bounds,
                    in: lookup,
                    boundsLookup: boundsLookup,
                    identifierLookup: identifierLookup
                )
                return injectSdkOnlyNodes(
                    element: child,
                    sdkNode: childSdk,
                    lookup: lookup,
                    boundsLookup: boundsLookup,
                    identifierLookup: identifierLookup,
                    matchedSdkKeyCounts: matchedSdkKeyCounts,
                    injectedParentKeys: &injectedParentKeys
                )
            }
        } else {
            processedChildren = nil
        }

        // Find SDK children of this node that have no XCUITest counterpart.
        // Use a local count to handle identical siblings: if 3 SDK children share
        // a key but only 2 were matched, the 3rd should still be injected.
        var injected: [UIElementInfo] = []
        if let currentSdk,
           injectedParentKeys.insert(exactKey(for: currentSdk)).inserted,
           let sdkChildren = currentSdk.children {
            var localKeyCounts: [LookupKey: Int] = [:]
            for sdkChild in sdkChildren {
                let childKey = exactKey(for: sdkChild)
                localKeyCounts[childKey, default: 0] += 1
                let matchedCount = matchedSdkKeyCounts[childKey] ?? 0
                // childKey was inserted into localKeyCounts earlier in this same loop.
                if localKeyCounts[childKey]! > matchedCount && isWorthInjecting(sdkChild) {  // swiftlint:disable:this force_unwrapping
                    injected.append(convertSdkNode(sdkChild))
                }
            }
        }

        // If no injections needed, return as-is
        guard !injected.isEmpty else {
            if processedChildren != nil && processedChildren?.count != element.node?.count {
                return element // shouldn't happen, but safety
            }
            return UIElementInfo(
                text: element.text,
                value: element.value,
                textSize: element.textSize,
                contentDesc: element.contentDesc,
                resourceId: element.resourceId,
                className: element.className,
                bounds: element.bounds,
                clickable: element.clickable,
                enabled: element.enabled,
                focusable: element.focusable,
                focused: element.focused,
                accessibilityFocused: element.accessibilityFocused,
                scrollable: element.scrollable,
                password: element.password,
                checkable: element.checkable,
                checked: element.checked,
                selected: element.selected,
                longClickable: element.longClickable,
                testTag: element.testTag,
                role: element.role,
                stateDescription: element.stateDescription,
                errorMessage: element.errorMessage,
                hintText: element.hintText,
                viewId: element.viewId,
                extras: element.extras,
                actions: element.actions,
                node: processedChildren
            )
        }

        // Merge existing children with injected SDK-only nodes
        var merged = processedChildren ?? []
        merged.append(contentsOf: injected)

        return UIElementInfo(
            text: element.text,
            value: element.value,
            textSize: element.textSize,
            contentDesc: element.contentDesc,
            resourceId: element.resourceId,
            className: element.className,
            bounds: element.bounds,
            clickable: element.clickable,
            enabled: element.enabled,
            focusable: element.focusable,
            focused: element.focused,
            accessibilityFocused: element.accessibilityFocused,
            scrollable: element.scrollable,
            password: element.password,
            checkable: element.checkable,
            checked: element.checked,
            selected: element.selected,
            longClickable: element.longClickable,
            testTag: element.testTag,
            role: element.role,
            stateDescription: element.stateDescription,
            errorMessage: element.errorMessage,
            hintText: element.hintText,
            viewId: element.viewId,
            extras: element.extras,
            actions: element.actions,
            node: merged.isEmpty ? nil : merged
        )
    }

    /// Whether an SDK-only node is worth injecting into the XCUITest tree.
    /// Skips purely structural container views that add no useful information.
    private static func isWorthInjecting(_ node: SdkViewNode) -> Bool {
        // Must have an accessibility identifier, label, custom actions, or be interactive
        if node.accessibilityIdentifier != nil { return true }
        if node.accessibilityLabel != nil { return true }
        if !node.accessibilityCustomActions.isEmpty { return true }
        if node.hasTapTarget { return true }
        if node.accessibilityElementsHidden { return true }
        if node.isAccessibilityElement { return true }
        // Has meaningful visual properties (background, corner radius, border)
        if node.backgroundColor != nil { return true }
        if node.cornerRadius > 0 { return true }
        if node.borderColor != nil { return true }
        if node.borderWidth > 0 { return true }
        // Layer-only node surfaces SwiftUI shape visuals that UIView walking misses.
        if node.isLayerNode { return true }
        // Has non-trivial children worth surfacing
        if let children = node.children, children.contains(where: { isWorthInjecting($0) }) {
            return true
        }
        return false
    }

    /// Convert an SDK node (and its subtree) to a UIElementInfo for injection.
    private static func convertSdkNode(_ node: SdkViewNode) -> UIElementInfo {
        var extras: [String: String] = ["sdk.source": "sdkWalker"]

        if !node.accessibilityTraits.isEmpty {
            extras["sdk.accessibilityTraits"] = node.accessibilityTraits.joined(separator: ",")
        }
        if !node.accessibilityCustomActions.isEmpty {
            extras["sdk.accessibilityCustomActions"] = node.accessibilityCustomActions.joined(separator: ",")
        }
        if !node.gestureRecognizers.isEmpty {
            let gestures = node.gestureRecognizers.map { "\($0.type)(\($0.isEnabled ? "enabled" : "disabled"))" }
            extras["sdk.gestureRecognizers"] = gestures.joined(separator: ",")
        }
        if let bg = node.backgroundColor {
            extras["sdk.backgroundColor"] = bg
        }
        extras["sdk.alpha"] = String(node.alpha)
        if node.cornerRadius > 0 {
            extras["sdk.cornerRadius"] = String(node.cornerRadius)
        }
        if let borderColor = node.borderColor {
            extras["sdk.borderColor"] = borderColor
        }
        if node.borderWidth > 0 {
            extras["sdk.borderWidth"] = String(node.borderWidth)
        }
        if node.isLayerNode {
            extras["sdk.isLayerNode"] = "true"
        }
        extras["sdk.isAccessibilityElement"] = String(node.isAccessibilityElement)
        if node.accessibilityElementsHidden {
            extras["sdk.accessibilityElementsHidden"] = "true"
        }
        extras["sdk.hasTapTarget"] = String(node.hasTapTarget)
        if node.isOccluded {
            extras["sdk.isOccluded"] = "true"
        }
        extras["sdk.isUserInteractionEnabled"] = String(node.isUserInteractionEnabled)

        let convertedChildren: [UIElementInfo]? = node.children?.compactMap { child in
            if isWorthInjecting(child) {
                return convertSdkNode(child)
            }
            return nil
        }

        return UIElementInfo(
            text: node.accessibilityLabel,
            resourceId: node.accessibilityIdentifier,
            className: node.className,
            bounds: ElementBounds(
                left: node.bounds.left,
                top: node.bounds.top,
                right: node.bounds.right,
                bottom: node.bounds.bottom
            ),
            // Preserve the VoiceOver cursor flag on SDK-only nodes that are injected
            // into the tree without an XCUITest counterpart (#3924).
            accessibilityFocused: node.isAccessibilityFocused ? "true" : nil,
            extras: extras,
            node: convertedChildren?.isEmpty == true ? nil : convertedChildren
        )
    }

    /// Build the exact (no tolerance) lookup key for an SDK node.
    private static func exactKey(for node: SdkViewNode) -> LookupKey {
        LookupKey(
            className: node.className,
            left: node.bounds.left,
            top: node.bounds.top,
            right: node.bounds.right,
            bottom: node.bounds.bottom
        )
    }
}
