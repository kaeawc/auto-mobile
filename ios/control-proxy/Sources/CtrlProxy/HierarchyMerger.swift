import Foundation

/// Merges XCUITest-based `ViewHierarchy` with SDK's in-process `SdkViewHierarchy`,
/// populating the `extras` field on each `UIElementInfo` node with `sdk.*` keys.
///
/// If no SDK hierarchy is available, returns the XCUITest hierarchy unchanged.
public enum HierarchyMerger {
    /// Tolerance in points for bounds matching between XCUITest and SDK nodes.
    private static let boundsTolerance = 2

    /// Observes how many XCUITest nodes have their SDK match resolved. Injected in
    /// tests to prove the tree is matched exactly once (one record per node) rather
    /// than the three passes the pre-#5475 implementation performed.
    final class MatchCounter {
        private(set) var count = 0
        func record() { count += 1 }
    }

    /// Merge SDK hierarchy data into the XCUITest hierarchy.
    ///
    /// Single-pass merge: every XCUITest node is matched against the SDK tree exactly
    /// once (`matchTree`), and that cached result is threaded through enrichment and
    /// SDK-only injection instead of re-matching per phase.
    /// 1. **Enrich** — annotate existing XCUITest nodes with `sdk.*` extras from matched SDK nodes.
    /// 2. **Inject** — add SDK-only nodes (views absent from the XCUITest tree) as children
    ///    of their nearest matched parent. Injected nodes carry `sdk.source=sdkWalker`.
    public static func merge(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy?) -> ViewHierarchy {
        merge(xcuitest: xcuitest, sdk: sdk, matchCounter: nil)
    }

    /// Test-observable entry point. `matchCounter`, when supplied, records one tick per
    /// XCUITest node whose SDK match is resolved.
    static func merge(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy?, matchCounter: MatchCounter?) -> ViewHierarchy {
        guard let sdk else { return xcuitest }
        let safeArea = sdk.safeAreaInsets.map {
            EdgeInsetsInfo(top: $0.top, right: $0.right, bottom: $0.bottom, left: $0.left)
        }
        let systemChrome = sdk.systemChrome.map {
            SystemChromeInfo(
                visibility: $0.visibility,
                statusBar: $0.statusBar,
                homeIndicatorAutoHideRequested: $0.homeIndicatorAutoHideRequested,
                source: $0.source
            )
        }
        let enrichedInsets =
            if let safeArea {
                ObservationInsetsInfo(
                    available: true,
                    source: "ios-sdk-safe-area",
                    units: "points",
                    safeArea: safeArea,
                    systemChrome: systemChrome
                )
            } else if let systemChrome {
                ObservationInsetsInfo(
                    available: xcuitest.insets.available,
                    source: xcuitest.insets.source,
                    units: xcuitest.insets.units,
                    safeArea: xcuitest.insets.safeArea,
                    systemChrome: systemChrome
                )
            } else {
                xcuitest.insets
            }
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
                nativeScale: xcuitest.nativeScale,
                pixelWidth: xcuitest.pixelWidth,
                pixelHeight: xcuitest.pixelHeight,
                rotation: xcuitest.rotation,
                systemInsets: safeArea ?? xcuitest.systemInsets,
                insets: enrichedInsets,
                error: xcuitest.error,
                fallbackToSpringboard: xcuitest.fallbackToSpringboard
            )
        }
        guard let xcuitestRoot = xcuitest.hierarchy else { return xcuitest }

        // Build flat lookups + a once-sorted-by-area list from the SDK tree.
        var lookup: [LookupKey: SdkViewNode] = [:]
        var boundsLookup: [BoundsKey: SdkViewNode] = [:]
        var identifierLookup: [String: SdkViewNode] = [:]
        var allSdkNodes: [SdkViewNode] = []
        buildLookup(
            node: sdkRoot,
            into: &lookup,
            boundsLookup: &boundsLookup,
            identifierLookup: &identifierLookup,
            allNodes: &allSdkNodes
        )

        let context = MatchContext(
            lookup: lookup,
            boundsLookup: boundsLookup,
            identifierLookup: identifierLookup,
            allSdkNodes: allSdkNodes,
            counter: matchCounter
        )

        // Single match pass: resolve each XCUITest node's SDK match once and cache both
        // the direct match (for injection placement) and the full match (direct or the
        // smallest enclosing node, for enrichment) on a mirror tree.
        let matched = matchTree(xcuitestRoot, context: context)

        // Counted bag of SDK keys that a full match consumed, so identical-keyed SDK
        // siblings aren't collapsed when deciding what to inject. Derived from the
        // cached matches — no re-matching.
        var matchedSdkKeyCounts: [LookupKey: Int] = [:]
        accumulateMatchedKeys(matched, into: &matchedSdkKeyCounts)

        // Build the enriched + injected output tree from the cached matches.
        var injectedParentKeys = Set<LookupKey>()
        let injectedRoot = buildNode(
            matched,
            matchedSdkKeyCounts: matchedSdkKeyCounts,
            injectedParentKeys: &injectedParentKeys
        ).element

        return ViewHierarchy(
            updatedAt: xcuitest.updatedAt,
            packageName: xcuitest.packageName,
            hierarchy: injectedRoot,
            windowInfo: xcuitest.windowInfo,
            windows: xcuitest.windows,
            screenScale: xcuitest.screenScale,
            screenWidth: xcuitest.screenWidth,
            screenHeight: xcuitest.screenHeight,
            nativeScale: xcuitest.nativeScale,
            pixelWidth: xcuitest.pixelWidth,
            pixelHeight: xcuitest.pixelHeight,
            rotation: xcuitest.rotation,
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
                buildLookup(
                    node: child,
                    into: &lookup,
                    boundsLookup: &boundsLookup,
                    identifierLookup: &identifierLookup,
                    allNodes: &allNodes
                )
            }
        }
    }

    // MARK: - Match context

    /// Cache key for a direct match query. Direct matches depend only on the query's
    /// class name, resource id, and bounds, so identical-bounds siblings share a slot
    /// and never re-run the 625-probe tolerance neighborhood.
    private struct DirectKey: Hashable {
        let className: String?
        let resourceId: String?
        let bounds: BoundsKey?
    }

    /// Holds the SDK indices plus per-merge memoization for the two lookup strategies
    /// (direct match, smallest-enclosing scan). The enclosing scan runs against a list
    /// sorted by area once, so the first container encountered is the smallest-area one.
    private final class MatchContext {
        let lookup: [LookupKey: SdkViewNode]
        let boundsLookup: [BoundsKey: SdkViewNode]
        let identifierLookup: [String: SdkViewNode]
        /// SDK nodes sorted by ascending area. Swift's sort is stable, so equal-area
        /// nodes retain their original document order — matching the old scan's
        /// "first smallest-area container wins" tie-break exactly.
        let sortedByArea: [SdkViewNode]
        let counter: MatchCounter?

        // `Optional<SdkViewNode>` value distinguishes a cached miss (`.some(nil)`) from
        // an absent entry (`nil`), so misses are memoized too.
        private var directCache: [DirectKey: SdkViewNode?] = [:]
        private var enclosingCache: [BoundsKey: SdkViewNode?] = [:]

        init(
            lookup: [LookupKey: SdkViewNode],
            boundsLookup: [BoundsKey: SdkViewNode],
            identifierLookup: [String: SdkViewNode],
            allSdkNodes: [SdkViewNode],
            counter: MatchCounter?
        ) {
            self.lookup = lookup
            self.boundsLookup = boundsLookup
            self.identifierLookup = identifierLookup
            sortedByArea = allSdkNodes.sorted { lhs, rhs in
                (lhs.bounds.width * lhs.bounds.height) < (rhs.bounds.width * rhs.bounds.height)
            }
            self.counter = counter
        }

        func directMatch(className: String?, resourceId: String?, bounds: ElementBounds?) -> SdkViewNode? {
            let key = DirectKey(
                className: className,
                resourceId: resourceId,
                bounds: bounds.map { BoundsKey(left: $0.left, top: $0.top, right: $0.right, bottom: $0.bottom) }
            )
            if let cached = directCache[key] { return cached }
            let result = findDirectMatch(
                className: className,
                resourceId: resourceId,
                bounds: bounds,
                in: lookup,
                boundsLookup: boundsLookup,
                identifierLookup: identifierLookup
            )
            directCache[key] = result
            return result
        }

        /// Smallest enclosing SDK node for `bounds` (for SwiftUI views whose accessibility
        /// bounds differ from UIKit). Cached per bounds so identical-bounds siblings do not
        /// re-scan the tree.
        func enclosingMatch(bounds: ElementBounds?) -> SdkViewNode? {
            guard let bounds else { return nil }
            let key = BoundsKey(left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom)
            if let cached = enclosingCache[key] { return cached }
            let tol = boundsTolerance
            var result: SdkViewNode?
            for node in sortedByArea {
                let nb = node.bounds
                if nb.left - tol <= bounds.left,
                   nb.top - tol <= bounds.top,
                   nb.right + tol >= bounds.right,
                   nb.bottom + tol >= bounds.bottom
                {
                    // First container in ascending-area order is the smallest-area one.
                    result = node
                    break
                }
            }
            enclosingCache[key] = result
            return result
        }
    }

    /// XCUITest tree mirror carrying each node's resolved SDK matches so downstream
    /// phases read cached results instead of re-matching.
    private struct MatchedNode {
        let element: UIElementInfo
        /// `findDirectMatch` result — used for SDK-only injection placement.
        let directMatch: SdkViewNode?
        /// `findMatch` result (direct, else smallest enclosing) — used for enrichment.
        let fullMatch: SdkViewNode?
        let children: [MatchedNode]?
    }

    /// Single match pass. Resolves the direct and full match for `element` once, records
    /// the resolution, and recurses. Every node is matched exactly once here.
    private static func matchTree(_ element: UIElementInfo, context: MatchContext) -> MatchedNode {
        context.counter?.record()
        let direct = context.directMatch(
            className: element.className,
            resourceId: element.resourceId,
            bounds: element.bounds
        )
        // Enrichment uses the smallest-enclosing fallback only when there is no direct hit,
        // mirroring the old `findMatch` (direct ?? enclosing).
        let full = direct ?? context.enclosingMatch(bounds: element.bounds)
        let children = element.node?.map { matchTree($0, context: context) }
        return MatchedNode(element: element, directMatch: direct, fullMatch: full, children: children)
    }

    /// Find a direct SDK counterpart for an XCUITest element.
    /// Direct matches are safe to use for SDK-only injection placement; containment
    /// matches are enrichment-only because broad containers can match many descendants.
    /// Strategy: (1) exact className+bounds, (2) bounds-only, (3) accessibilityIdentifier.
    private static func findDirectMatch(
        className: String?,
        resourceId: String?,
        bounds: ElementBounds?,
        in lookup: [LookupKey: SdkViewNode],
        boundsLookup: [BoundsKey: SdkViewNode],
        identifierLookup: [String: SdkViewNode]
    )
        -> SdkViewNode?
    {
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
    )
        -> SdkViewNode?
    {
        let tol = boundsTolerance
        for dl in -tol ... tol {
            for dt in -tol ... tol {
                for dr in -tol ... tol {
                    for db in -tol ... tol {
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

    // MARK: - Matched-key accounting

    /// Walk the cached match tree and tally the exact lookup key of every full match,
    /// so injection can tell which SDK nodes already have an XCUITest counterpart.
    /// Uses a counted bag so identical-keyed siblings each get their own match slot.
    private static func accumulateMatchedKeys(_ node: MatchedNode, into matched: inout [LookupKey: Int]) {
        if let sdkNode = node.fullMatch {
            matched[exactKey(for: sdkNode), default: 0] += 1
        }
        if let children = node.children {
            for child in children {
                accumulateMatchedKeys(child, into: &matched)
            }
        }
    }

    // MARK: - Enrichment + injection (single output pass)

    /// Build the enriched, SDK-only-injected `UIElementInfo` for a matched node from
    /// its cached matches. Returns `changed == false` (and the original element) when
    /// there is no full match and nothing in the subtree changed, so the 25+ field
    /// `UIElementInfo` copy is skipped for untouched nodes.
    private static func buildNode(
        _ node: MatchedNode,
        matchedSdkKeyCounts: [LookupKey: Int],
        injectedParentKeys: inout Set<LookupKey>
    )
        -> (element: UIElementInfo, changed: Bool)
    {
        let element = node.element

        // Recurse into existing children first, mirroring the old post-order traversal so
        // `injectedParentKeys` dedup order (deepest-first) is preserved.
        var processedChildren: [UIElementInfo]?
        var childrenChanged = false
        if let children = node.children {
            var out = [UIElementInfo]()
            out.reserveCapacity(children.count)
            for child in children {
                let built = buildNode(
                    child,
                    matchedSdkKeyCounts: matchedSdkKeyCounts,
                    injectedParentKeys: &injectedParentKeys
                )
                out.append(built.element)
                if built.changed { childrenChanged = true }
            }
            processedChildren = out
        }

        // SDK children of the direct match that have no XCUITest counterpart get injected.
        // Local counts handle identical siblings: if 3 SDK children share a key but only 2
        // were matched, the 3rd is still injected.
        var injected: [UIElementInfo] = []
        if let currentSdk = node.directMatch,
           injectedParentKeys.insert(exactKey(for: currentSdk)).inserted,
           let sdkChildren = currentSdk.children
        {
            var localKeyCounts: [LookupKey: Int] = [:]
            for sdkChild in sdkChildren {
                let childKey = exactKey(for: sdkChild)
                let localCount = (localKeyCounts[childKey] ?? 0) + 1
                localKeyCounts[childKey] = localCount
                let matchedCount = matchedSdkKeyCounts[childKey] ?? 0
                if localCount > matchedCount, isWorthInjecting(sdkChild) {
                    injected.append(convertSdkNode(sdkChild))
                }
            }
        }

        // Enrichment from the full match (direct or smallest enclosing).
        let enrichedExtras = buildExtras(existing: element.extras, sdkNode: node.fullMatch)
        // XCUITest cannot observe the VoiceOver cursor, so this flag only ever arrives
        // from the matched in-app SDK node; fall back to the existing value when there is
        // no SDK match. Follows the "true"-or-nil convention (#3924).
        let enrichedFocused = node.fullMatch?.isAccessibilityFocused == true ? "true" : element.accessibilityFocused
        let enrichmentChanged = node.fullMatch != nil &&
            (enrichedExtras != element.extras || enrichedFocused != element.accessibilityFocused)

        // Nothing touched this node or its subtree — return the original by value, skipping
        // the field-by-field copy.
        if !enrichmentChanged, !childrenChanged, injected.isEmpty {
            return (element, false)
        }

        let finalChildren: [UIElementInfo]?
        if injected.isEmpty {
            finalChildren = processedChildren
        } else {
            var merged = processedChildren ?? []
            merged.append(contentsOf: injected)
            finalChildren = merged.isEmpty ? nil : merged
        }

        let rebuilt = UIElementInfo(
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
            accessibilityFocused: enrichedFocused,
            scrollable: element.scrollable,
            password: element.password,
            checkable: element.checkable,
            checked: element.checked,
            selected: element.selected,
            longClickable: element.longClickable,
            semanticLinks: element.semanticLinks,
            testTag: element.testTag,
            role: element.role,
            stateDescription: element.stateDescription,
            errorMessage: element.errorMessage,
            hintText: element.hintText,
            viewId: element.viewId,
            extras: enrichedExtras,
            actions: element.actions,
            node: finalChildren
        )
        return (rebuilt, true)
    }

    /// Populate `sdk.*` extras from a matched SDK node. Only non-default SDK fields are
    /// emitted, so a fully-default match adds nothing and a node with no prior extras and
    /// a default match yields `nil` (no dictionary allocation surfaced downstream).
    private static func buildExtras(existing: [String: String]?, sdkNode: SdkViewNode?) -> [String: String]? {
        guard let node = sdkNode else { return existing }
        let extras = appendSdkExtras(to: existing, from: node)
        // Preserve the original "empty means nil" contract.
        return (extras?.isEmpty ?? true) ? nil : extras
    }

    /// Append the non-default `sdk.*` visual/accessibility fields of `node` onto `base`.
    /// Returns `nil` when nothing was appended and `base` was `nil`, so callers can avoid
    /// allocating an empty dictionary. Shared by enrichment and SDK-only conversion.
    private static func appendSdkExtras(to base: [String: String]?, from node: SdkViewNode) -> [String: String]? {
        var extras = base
        func set(_ key: String, _ value: String) {
            if extras == nil { extras = [:] }
            extras?[key] = value
        }

        if !node.accessibilityTraits.isEmpty {
            set("sdk.accessibilityTraits", node.accessibilityTraits.joined(separator: ","))
        }
        if !node.accessibilityCustomActions.isEmpty {
            set("sdk.accessibilityCustomActions", node.accessibilityCustomActions.joined(separator: ","))
        }
        if !node.gestureRecognizers.isEmpty {
            let gestures = node.gestureRecognizers.map { "\($0.type)(\($0.isEnabled ? "enabled" : "disabled"))" }
            set("sdk.gestureRecognizers", gestures.joined(separator: ","))
        }
        if let bg = node.backgroundColor {
            set("sdk.backgroundColor", bg)
        }
        // Defaults per SdkViewNode: alpha 1.0, isAccessibilityElement false,
        // hasTapTarget false, isUserInteractionEnabled true. Skip them so default matches
        // carry no redundant keys (issue #5475).
        if node.alpha != 1.0 {
            set("sdk.alpha", String(node.alpha))
        }
        if node.cornerRadius > 0 {
            set("sdk.cornerRadius", String(node.cornerRadius))
        }
        if let borderColor = node.borderColor {
            set("sdk.borderColor", borderColor)
        }
        if node.borderWidth > 0 {
            set("sdk.borderWidth", String(node.borderWidth))
        }
        if node.isLayerNode {
            set("sdk.isLayerNode", "true")
        }
        if node.isAccessibilityElement {
            set("sdk.isAccessibilityElement", "true")
        }
        if node.accessibilityElementsHidden {
            set("sdk.accessibilityElementsHidden", "true")
        }
        if node.hasTapTarget {
            set("sdk.hasTapTarget", "true")
        }
        if node.isOccluded {
            set("sdk.isOccluded", "true")
        }
        if !node.isUserInteractionEnabled {
            set("sdk.isUserInteractionEnabled", "false")
        }
        return extras
    }

    // MARK: - Injection helpers

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
        // `sdk.source` marks injected nodes and is always present; the remaining sdk.*
        // fields are appended only when non-default (issue #5475).
        let extras = appendSdkExtras(to: ["sdk.source": "sdkWalker"], from: node) ?? ["sdk.source": "sdkWalker"]

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
