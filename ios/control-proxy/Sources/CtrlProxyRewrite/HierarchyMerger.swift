import Foundation

/// Merges XCUITest-based `ViewHierarchy` with SDK's in-process `SdkViewHierarchy`,
/// populating the `extras` field on each `UIElementInfo` node with `sdk.*` keys.
///
/// If no SDK hierarchy is available, returns the XCUITest hierarchy unchanged.
///
/// Ported verbatim from the reference target. Pure transform: all state is local
/// to a single synchronous `merge` call (the private `MatchContext` memo caches
/// never escape), so it needs no isolation. The nested helper types are algorithm
/// internals of the merge and stay in this file (the "very closely related"
/// exception to one-type-per-file).
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
        let displayCutoutInfo = sdk.displayCutoutInfo.map {
            DisplayCutoutInfo(
                classification: $0.classification,
                bounds: $0.bounds?.map {
                    ElementBounds(left: $0.left, top: $0.top, right: $0.right, bottom: $0.bottom)
                }
            )
        } ?? xcuitest.insets.displayCutoutInfo
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
                    displayCutoutInfo: displayCutoutInfo,
                    systemChrome: systemChrome
                )
            } else if let systemChrome {
                ObservationInsetsInfo(
                    available: xcuitest.insets.available,
                    source: xcuitest.insets.source,
                    units: xcuitest.insets.units,
                    safeArea: xcuitest.insets.safeArea,
                    displayCutoutInfo: displayCutoutInfo,
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
        var xcuitestNodesByClass: [String: [UIElementInfo]] = [:]
        indexXcuitestNodes(xcuitestRoot, into: &xcuitestNodesByClass)

        // Build the enriched + injected output tree from the cached matches.
        var injectedParentKeys = Set<InjectionKey>()
        var injectedNodeKeys = Set<InjectionKey>()
        let injectedRoot = buildNode(
            matched,
            xcuitestNodesByClass: xcuitestNodesByClass,
            injectedParentKeys: &injectedParentKeys,
            injectedNodeKeys: &injectedNodeKeys
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

    /// SDK subtrees with the same visible identity and children are one injection.
    /// Child identities keep distinct SDK-only content under colocated wrappers.
    private struct InjectionKey: Hashable {
        let bounds: LookupKey
        let identifier: String?
        let label: String?
        let children: [InjectionKey]
    }

    private static func injectionKey(for node: SdkViewNode) -> InjectionKey {
        InjectionKey(
            bounds: exactKey(for: node),
            identifier: node.accessibilityIdentifier,
            label: node.accessibilityLabel,
            children: node.children?.map { injectionKey(for: $0) } ?? []
        )
    }

    private static func classFamily(_ className: String) -> String {
        switch className {
        case "UIKitTextField", "UITextField": return "UITextField"
        case "UIKitSearchBar", "UISearchBar": return "UISearchBar"
        default: return className
        }
    }

    private static func indexXcuitestNodes(_ node: UIElementInfo, into index: inout [String: [UIElementInfo]]) {
        if let className = node.className {
            index[classFamily(className), default: []].append(node)
        }
        for child in node.node ?? [] {
            indexXcuitestNodes(child, into: &index)
        }
    }

    private static func isCounterpart(_ sdkNode: SdkViewNode, of element: UIElementInfo) -> Bool {
        guard let className = element.className,
              let bounds = element.bounds
        else { return false }
        return isCounterpart(sdkNode, className: className, identifier: element.resourceId, bounds: bounds)
    }

    private static func isCounterpart(
        _ sdkNode: SdkViewNode,
        className: String,
        identifier: String?,
        bounds: ElementBounds
    )
        -> Bool
    {
        guard classFamily(className) == classFamily(sdkNode.className) else { return false }
        if let sdkId = sdkNode.accessibilityIdentifier, !sdkId.isEmpty,
           let identifier, !identifier.isEmpty, sdkId != identifier
        {
            return false
        }
        let sdkBounds = sdkNode.bounds
        return abs(bounds.left - sdkBounds.left) <= boundsTolerance &&
            abs(bounds.top - sdkBounds.top) <= boundsTolerance &&
            abs(bounds.right - sdkBounds.right) <= boundsTolerance &&
            abs(bounds.bottom - sdkBounds.bottom) <= boundsTolerance
    }

    private static func isRepresented(_ sdkNode: SdkViewNode, by index: [String: [UIElementInfo]]) -> Bool {
        index[classFamily(sdkNode.className)]?.contains { isCounterpart(sdkNode, of: $0) } == true
    }

    private static func identifiersCompatible(_ sdkNode: SdkViewNode, _ resourceId: String?) -> Bool {
        guard let sdkId = sdkNode.accessibilityIdentifier, !sdkId.isEmpty,
              let resourceId, !resourceId.isEmpty
        else { return true }
        return sdkId == resourceId
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
        let sdkNodesByClass: [String: [SdkViewNode]]
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
            sdkNodesByClass = Dictionary(grouping: allSdkNodes, by: { classFamily($0.className) })
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
            // Prefer a real counterpart before the legacy bounds-only fallback,
            // which can pick a colocated UIKit wrapper instead of its text field.
            var strict: SdkViewNode?
            if let className, let bounds {
                let candidates = sdkNodesByClass[classFamily(className)]?.filter {
                    isCounterpart($0, className: className, identifier: resourceId, bounds: bounds)
                } ?? []
                func exactBounds(_ node: SdkViewNode) -> Bool {
                    node.bounds.left == bounds.left && node.bounds.top == bounds.top &&
                        node.bounds.right == bounds.right && node.bounds.bottom == bounds.bottom
                }
                func sameIdentifier(_ node: SdkViewNode) -> Bool {
                    resourceId != nil && node.accessibilityIdentifier == resourceId
                }
                strict = candidates.first { sameIdentifier($0) && exactBounds($0) } ??
                    candidates.first { sameIdentifier($0) } ??
                    candidates.first { exactBounds($0) } ?? candidates.first
            }
            let result = strict ?? findDirectMatch(
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
        let enclosing = context.enclosingMatch(bounds: element.bounds)
        let full = direct ?? enclosing.flatMap { identifiersCompatible($0, element.resourceId) ? $0 : nil }
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
                )], identifiersCompatible(exact, resourceId) {
                    return exact
                }
                if let near = probeToleranceMatch(bounds: bounds, in: lookup, makeKey: { l, t, r, b in
                    LookupKey(className: className, left: l, top: t, right: r, bottom: b)
                }, accept: { identifiersCompatible($0, resourceId) }) {
                    return near
                }
            }
            // 2. Bounds-only fallback: different class names at the same position,
            //    exact then within ±tolerance.
            if let boundsMatch = boundsLookup[BoundsKey(
                left: bounds.left, top: bounds.top,
                right: bounds.right, bottom: bounds.bottom
            )], identifiersCompatible(boundsMatch, resourceId) {
                return boundsMatch
            }
            if let near = probeToleranceMatch(bounds: bounds, in: boundsLookup, makeKey: { l, t, r, b in
                BoundsKey(left: l, top: t, right: r, bottom: b)
            }, accept: { identifiersCompatible($0, resourceId) }) {
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
        makeKey: (_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> Key,
        accept: (SdkViewNode) -> Bool
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
                        if let hit = index[key], accept(hit) {
                            return hit
                        }
                    }
                }
            }
        }
        return nil
    }

    // MARK: - Enrichment + injection (single output pass)

    /// Build the enriched, SDK-only-injected `UIElementInfo` for a matched node from
    /// its cached matches. Returns `changed == false` (and the original element) when
    /// there is no full match and nothing in the subtree changed, so the 25+ field
    /// `UIElementInfo` copy is skipped for untouched nodes.
    private static func buildNode(
        _ node: MatchedNode,
        xcuitestNodesByClass: [String: [UIElementInfo]],
        injectedParentKeys: inout Set<InjectionKey>,
        injectedNodeKeys: inout Set<InjectionKey>
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
                    xcuitestNodesByClass: xcuitestNodesByClass,
                    injectedParentKeys: &injectedParentKeys,
                    injectedNodeKeys: &injectedNodeKeys
                )
                out.append(built.element)
                if built.changed { childrenChanged = true }
            }
            processedChildren = out
        }

        // SDK children of the direct match that have no XCUITest counterpart get injected.
        // Prune matched descendants too: an unmatched wrapper can contain UIKit views
        // that XCUITest already exposed elsewhere in its hierarchy.
        var injected: [UIElementInfo] = []
        if let currentSdk = node.directMatch,
           injectedParentKeys.insert(injectionKey(for: currentSdk)).inserted,
           let sdkChildren = currentSdk.children
        {
            for sdkChild in sdkChildren {
                if let converted = convertSdkNode(
                    sdkChild,
                    xcuitestNodesByClass: xcuitestNodesByClass,
                    injectedNodeKeys: &injectedNodeKeys
                ) {
                    injected.append(converted)
                }
            }
        }

        // Enrichment from the full match (direct or smallest enclosing).
        let enrichedExtras = buildExtras(existing: element.extras, sdkNode: node.fullMatch)
        // XCUITest cannot observe the VoiceOver cursor, so this flag only ever arrives
        // from the matched in-app SDK node; fall back to the existing value when there is
        // no SDK match. Follows the "true"-or-nil convention (#3924).
        let enrichedFocused = node.fullMatch?.isAccessibilityFocused == true ? "true" : element.accessibilityFocused
        // Inline semantic links only the in-app SDK can see (attributed text /
        // SwiftUI link accessibility elements) are projected onto the owning
        // element as the Android-parity `semanticLinks` (issue #5560). Prefer the
        // SDK's richer links (real occurrence + range) when present; otherwise keep
        // whatever XCUITest already surfaced (e.g. a standalone `.link` element).
        let enrichedSemanticLinks = semanticLinks(from: node.fullMatch) ?? element.semanticLinks
        let enrichmentChanged = node.fullMatch != nil &&
            (
                enrichedExtras != element.extras ||
                    enrichedFocused != element.accessibilityFocused ||
                    enrichedSemanticLinks != element.semanticLinks
            )

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
            semanticLinks: enrichedSemanticLinks,
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

    /// Project a matched SDK node's inline links onto the Android-parity wire
    /// shape (`text`/`occurrence`/range), dropping the iOS-only activation center.
    /// Returns `nil` when the node has no links, so callers can fall back to any
    /// links XCUITest already surfaced.
    private static func semanticLinks(from sdkNode: SdkViewNode?) -> [SemanticLink]? {
        guard let links = sdkNode?.semanticLinks, !links.isEmpty else { return nil }
        return links.map { SemanticLink(text: $0.text, occurrence: $0.occurrence, start: $0.start, end: $0.end) }
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

    /// Whether this SDK node contributes content on its own. A structural wrapper
    /// is retained only if it has an SDK-only descendant after pruning.
    private static func hasMeaningfulContent(_ node: SdkViewNode) -> Bool {
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
        return false
    }

    /// Convert an SDK node (and its subtree) to a UIElementInfo for injection.
    private static func convertSdkNode(
        _ node: SdkViewNode,
        xcuitestNodesByClass: [String: [UIElementInfo]],
        injectedNodeKeys: inout Set<InjectionKey>
    )
        -> UIElementInfo?
    {
        if isRepresented(node, by: xcuitestNodesByClass) { return nil }
        let key = injectionKey(for: node)
        if !injectedNodeKeys.insert(key).inserted { return nil }
        let convertedChildren = node.children?.compactMap { child in
            convertSdkNode(
                child,
                xcuitestNodesByClass: xcuitestNodesByClass,
                injectedNodeKeys: &injectedNodeKeys
            )
        }
        if !hasMeaningfulContent(node), convertedChildren?.isEmpty ?? true { return nil }
        // `sdk.source` marks injected nodes and is always present; the remaining sdk.*
        // fields are appended only when non-default (issue #5475).
        let extras = appendSdkExtras(to: ["sdk.source": "sdkWalker"], from: node) ?? ["sdk.source": "sdkWalker"]

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
