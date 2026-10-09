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

    /// How the ±tolerance direct match breaks ties between candidates (#5837).
    /// Production always uses `nearestThenDocumentOrder`; `legacyDeltaLoopOrder`
    /// reproduces the pre-#8662 625-probe loop so the golden replay can measure
    /// which real hierarchy pairs the reviewed behavior change affects.
    enum ToleranceTieBreak: Sendable {
        /// Smallest L∞ distance, then pre-order `NodeID`.
        case nearestThenDocumentOrder
        /// Exact bounds first, then the first `(dl, dt, dr, db)` delta in ascending
        /// nested-loop order whose first-inserted node (per class+bounds or bounds
        /// key) passes `accept`. A key whose first node fails `accept` is a miss.
        case legacyDeltaLoopOrder
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
    static func merge(
        xcuitest: ViewHierarchy,
        sdk: SdkViewHierarchy?,
        matchCounter: MatchCounter?,
        tieBreak: ToleranceTieBreak = .nearestThenDocumentOrder
    )
        -> ViewHierarchy
    {
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
                fallbackToSpringboard: xcuitest.fallbackToSpringboard,
                truncationReasons: xcuitest.truncationReasons
            )
        }
        guard let xcuitestRoot = xcuitest.hierarchy else { return xcuitest }

        // Build flat lookups + a once-sorted-by-area list from the SDK tree.
        var identifierLookup: [String: SdkViewNode] = [:]
        var allSdkNodes: [SdkViewNode] = []
        buildLookup(
            node: sdkRoot,
            identifierLookup: &identifierLookup,
            allNodes: &allSdkNodes
        )

        let context = MatchContext(
            identifierLookup: identifierLookup,
            allSdkNodes: allSdkNodes,
            counter: matchCounter,
            tieBreak: tieBreak
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
            fallbackToSpringboard: xcuitest.fallbackToSpringboard,
            truncationReasons: xcuitest.truncationReasons
        )
    }

    // MARK: - Lookup

    /// Pre-order SDK document index; `allNodes[id]` resolves the original node.
    private typealias NodeID = Int

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
        return coordinateDistance(bounds.left, sdkBounds.left) <= boundsTolerance &&
            coordinateDistance(bounds.top, sdkBounds.top) <= boundsTolerance &&
            coordinateDistance(bounds.right, sdkBounds.right) <= boundsTolerance &&
            coordinateDistance(bounds.bottom, sdkBounds.bottom) <= boundsTolerance
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
        identifierLookup: inout [String: SdkViewNode],
        allNodes: inout [SdkViewNode]
    ) {
        allNodes.append(node)
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
                    identifierLookup: &identifierLookup,
                    allNodes: &allNodes
                )
            }
        }
    }

    /// One endpoint's values sorted by (value, pre-order NodeID), retaining duplicates.
    private struct CoordinateIndex {
        let entries: [(value: Int, id: NodeID)]

        init(entries: [(value: Int, id: NodeID)]) {
            self.entries = entries.sorted {
                $0.value < $1.value || ($0.value == $1.value && $0.id < $1.id)
            }
        }

        func ids(inRange range: ClosedRange<Int>) -> Set<NodeID> {
            Set(window(inRange: range).map { $0.id })
        }

        func window(inRange range: ClosedRange<Int>) -> ArraySlice<(value: Int, id: NodeID)> {
            entries[lowerBound(range.lowerBound) ..< upperBound(range.upperBound)]
        }

        func prefix(through value: Int) -> ArraySlice<(value: Int, id: NodeID)> {
            entries[..<upperBound(value)]
        }

        func suffix(from value: Int) -> ArraySlice<(value: Int, id: NodeID)> {
            entries[lowerBound(value)...]
        }

        private func lowerBound(_ value: Int) -> Int {
            var low = 0
            var high = entries.count
            while low < high {
                let mid = low + (high - low) / 2
                if entries[mid].value < value {
                    low = mid + 1
                } else {
                    high = mid
                }
            }
            return low
        }

        private func upperBound(_ value: Int) -> Int {
            var low = 0
            var high = entries.count
            while low < high {
                let mid = low + (high - low) / 2
                if entries[mid].value <= value {
                    low = mid + 1
                } else {
                    high = mid
                }
            }
            return low
        }
    }

    /// Tiny test seam for the private coordinate index's inclusive NodeID set API.
    static func coordinateIDs(values: [Int], inRange range: ClosedRange<Int>) -> Set<Int> {
        CoordinateIndex(entries: values.enumerated().map { (value: $0.element, id: $0.offset) })
            .ids(inRange: range)
    }

    /// Batch test seam: build once, as in a merge, and compare exact pre-order NodeIDs.
    static func smallestEnclosingIDs(nodeBounds: [SdkBounds], queries: [ElementBounds]) -> [Int?] {
        let nodes: [SdkViewNode] = nodeBounds.map { bounds in
            SdkViewNode(className: "UIView", bounds: bounds)
        }
        let index = GeometryIndex(allNodes: nodes)
        return queries.map { index.smallestEnclosingID(bounds: $0) }
    }

    /// L-infinity distance, also a test seam for arithmetic that nearest's windows
    /// normally exclude. Unrepresentable absolute differences saturate to Int.max:
    /// they are never within tolerance and cannot become a nearest candidate.
    static func boundsDistance(_ sdkBounds: SdkBounds, _ bounds: ElementBounds) -> Int {
        max(
            max(coordinateDistance(sdkBounds.left, bounds.left), coordinateDistance(sdkBounds.top, bounds.top)),
            max(coordinateDistance(sdkBounds.right, bounds.right), coordinateDistance(sdkBounds.bottom, bounds.bottom))
        )
    }

    private static func coordinateDistance(_ lhs: Int, _ rhs: Int) -> Int {
        let (difference, overflow) = lhs.subtractingReportingOverflow(rhs)
        guard !overflow else { return Int.max }
        // magnitude is safe even for Int.min, whose positive value Int cannot hold.
        return Int(clamping: difference.magnitude)
    }

    private static func toleranceRange(around coordinate: Int) -> ClosedRange<Int> {
        let tol = boundsTolerance
        // Clip only overflowing endpoints; these windows are exactly the Int
        // coordinates whose mathematical absolute difference is at most tol.
        let lower = coordinate < Int.min + tol ? Int.min : coordinate - tol
        let upper = coordinate > Int.max - tol ? Int.max : coordinate + tol
        return lower ... upper
    }

    /// Signed dimensions saturate first, then an overflowing product saturates
    /// by sign. Inverted bounds retain their existing signed-area ordering.
    static func saturatingSignedArea(of bounds: SdkBounds) -> Int {
        let signedWidth = bounds.width
        let signedHeight = bounds.height
        let (area, areaOverflow) = signedWidth.multipliedReportingOverflow(by: signedHeight)
        guard areaOverflow else { return area }
        return (signedWidth < 0) == (signedHeight < 0) ? Int.max : Int.min
    }

    /// Built once per merge in O(n log n) time and O(n) space.
    private struct GeometryIndex {
        let allNodes: [SdkViewNode]
        let left: CoordinateIndex
        let top: CoordinateIndex
        let right: CoordinateIndex
        let bottom: CoordinateIndex
        let areaRank: [Int]

        init(allNodes: [SdkViewNode]) {
            self.allNodes = allNodes
            left = CoordinateIndex(entries: allNodes.enumerated().map {
                (value: $0.element.bounds.left, id: $0.offset)
            })
            top = CoordinateIndex(entries: allNodes.enumerated().map {
                (value: $0.element.bounds.top, id: $0.offset)
            })
            right = CoordinateIndex(entries: allNodes.enumerated().map {
                (value: $0.element.bounds.right, id: $0.offset)
            })
            bottom = CoordinateIndex(entries: allNodes.enumerated().map {
                (value: $0.element.bounds.bottom, id: $0.offset)
            })
            // A lone node is trivially rank zero, so avoid evaluating its area.
            var areas: [(area: Int, id: NodeID)] = []
            if allNodes.count >= 2 {
                // Keep signed areas (including inverted bounds), with the old stable
                // sort's pre-order tie-break made explicit. Compute each area once.
                for (id, node) in allNodes.enumerated() {
                    areas.append((area: saturatingSignedArea(of: node.bounds), id: id))
                }
            }
            let ordered: [(area: Int, id: NodeID)] = areas.sorted { lhs, rhs in
                if lhs.area == rhs.area {
                    return lhs.id < rhs.id
                }
                return lhs.area < rhs.area
            }
            var ranks = [Int](repeating: 0, count: allNodes.count)
            for (rank, entry) in ordered.enumerated() {
                ranks[entry.id] = rank
            }
            areaRank = ranks
        }

        /// Four one-sided prefix/suffix windows require four binary searches, O(log n),
        /// then O(k) checks of the smallest window and a single area-rank comparison
        /// per qualifying candidate. These are not interval-tree queries: k can be
        /// Theta(n), e.g. inside a full-screen overlay stack, so worst case remains
        /// O(n) per distinct query bounds (cached by MatchContext), no worse than the
        /// old scan. Typical windows scan far fewer than n nodes; no per-query sort.
        /// Select by (signed area, NodeID), without filtering class or identifier.
        func smallestEnclosingID(bounds: ElementBounds) -> NodeID? {
            let tol: Int = boundsTolerance
            // Saturation preserves the inequalities wherever the old checked Int
            // arithmetic was defined, without introducing overflow at query extremes.
            let upperLimit = Int.max - tol
            let lowerLimit = Int.min + tol
            let maxLeft: Int = bounds.left > upperLimit ? Int.max : bounds.left + tol
            let maxTop: Int = bounds.top > upperLimit ? Int.max : bounds.top + tol
            let minRight: Int = bounds.right < lowerLimit ? Int.min : bounds.right - tol
            let minBottom: Int = bounds.bottom < lowerLimit ? Int.min : bounds.bottom - tol
            let windows: [ArraySlice<(value: Int, id: NodeID)>] = [
                left.prefix(through: maxLeft),
                top.prefix(through: maxTop),
                right.suffix(from: minRight),
                bottom.suffix(from: minBottom),
            ]
            guard let candidates = windows.min(by: { $0.count < $1.count }) else { return nil }
            var bestID: NodeID?
            var bestRank = Int.max
            for entry in candidates {
                let nodeBounds = allNodes[entry.id].bounds
                guard nodeBounds.left <= maxLeft, nodeBounds.top <= maxTop,
                      nodeBounds.right >= minRight, nodeBounds.bottom >= minBottom
                else { continue }
                if areaRank[entry.id] < bestRank {
                    bestID = entry.id
                    bestRank = areaRank[entry.id]
                }
            }
            return bestID
        }

        /// Replaces ~625 probes per step (O(tol^4)) with four binary range searches
        /// (lower/upper bounds each), O(log n), independent of tol, then O(k) checks
        /// of the smallest coordinate window. Worst case k == n when all windows
        /// contain every node; no whole-tree scan or per-query sort is performed.
        /// All compatible candidates, including duplicates and exact bounds, compete
        /// by (L-infinity distance, NodeID), regardless of coordinate traversal order.
        func nearest(
            bounds: ElementBounds,
            className: String? = nil,
            tieBreak: ToleranceTieBreak = .nearestThenDocumentOrder,
            accept: (SdkViewNode) -> Bool
        )
            -> SdkViewNode?
        {
            let leftRange = toleranceRange(around: bounds.left)
            let topRange = toleranceRange(around: bounds.top)
            let rightRange = toleranceRange(around: bounds.right)
            let bottomRange = toleranceRange(around: bounds.bottom)
            let windows = [
                left.window(inRange: leftRange),
                top.window(inRange: topRange),
                right.window(inRange: rightRange),
                bottom.window(inRange: bottomRange),
            ]
            guard let candidates = windows.min(by: { $0.count < $1.count }) else { return nil }
            if tieBreak == .legacyDeltaLoopOrder {
                return legacyLoopOrderMatch(
                    bounds: bounds,
                    candidates: candidates,
                    className: className,
                    accept: accept
                )
            }
            var bestID: NodeID?
            var bestDistance = Int.max
            for entry in candidates {
                let node = allNodes[entry.id]
                let nb = node.bounds
                guard leftRange.contains(nb.left), topRange.contains(nb.top),
                      rightRange.contains(nb.right), bottomRange.contains(nb.bottom),
                      className.map({ node.className == $0 }) ?? true,
                      accept(node)
                else { continue }
                let distance = boundsDistance(nb, bounds)
                guard distance <= boundsTolerance else { continue }
                if distance < bestDistance || (distance == bestDistance && entry.id < (bestID ?? Int.max)) {
                    bestID = entry.id
                    bestDistance = distance
                }
            }
            return bestID.map { allNodes[$0] }
        }

        /// The pre-#8662 probe, kept only for the golden-replay comparison. The old
        /// dictionaries held the first-inserted node per key, so each distinct bounds
        /// key is represented by its minimum `NodeID`, and `accept` sees only that node.
        private func legacyLoopOrderMatch(
            bounds: ElementBounds,
            candidates: ArraySlice<(value: Int, id: NodeID)>,
            className: String?,
            accept: (SdkViewNode) -> Bool
        )
            -> SdkViewNode?
        {
            let tol = boundsTolerance
            var representatives: [BoundsKey: NodeID] = [:]
            for entry in candidates {
                let node = allNodes[entry.id]
                if let className, node.className != className { continue }
                let nb = node.bounds
                guard boundsDistance(nb, bounds) <= tol else { continue }
                let key = BoundsKey(left: nb.left, top: nb.top, right: nb.right, bottom: nb.bottom)
                if let existing = representatives[key], existing <= entry.id { continue }
                representatives[key] = entry.id
            }
            var best: (rank: Int, id: NodeID)?
            for (key, id) in representatives {
                guard accept(allNodes[id]) else { continue }
                let deltas = [
                    key.left - bounds.left, key.top - bounds.top,
                    key.right - bounds.right, key.bottom - bounds.bottom,
                ]
                // Exact bounds were looked up before the probe; the probe skipped delta zero.
                let rank = deltas.allSatisfy { $0 == 0 } ? -1 : deltas.reduce(0) { $0 * (2 * tol + 1) + ($1 + tol) }
                if best.map({ rank < $0.rank }) ?? true {
                    best = (rank, id)
                }
            }
            return best.map { allNodes[$0.id] }
        }
    }

    // MARK: - Match context

    /// Cache key for a direct match query. Direct matches depend only on the query's
    /// class name, resource id, and bounds, so identical-bounds siblings share a slot
    /// and never re-run the coordinate range query.
    private struct DirectKey: Hashable {
        let className: String?
        let resourceId: String?
        let bounds: BoundsKey?
    }

    /// Holds the SDK indices plus per-merge memoization for direct and enclosing queries.
    private final class MatchContext {
        let geometryIndex: GeometryIndex
        let identifierLookup: [String: SdkViewNode]
        let sdkNodesByClass: [String: [SdkViewNode]]
        let counter: MatchCounter?
        let tieBreak: ToleranceTieBreak

        // `Optional<SdkViewNode>` value distinguishes a cached miss (`.some(nil)`) from
        // an absent entry (`nil`), so misses are memoized too.
        private var directCache: [DirectKey: SdkViewNode?] = [:]
        private var enclosingCache: [BoundsKey: SdkViewNode?] = [:]

        init(
            identifierLookup: [String: SdkViewNode],
            allSdkNodes: [SdkViewNode],
            counter: MatchCounter?,
            tieBreak: ToleranceTieBreak
        ) {
            geometryIndex = GeometryIndex(allNodes: allSdkNodes)
            self.tieBreak = tieBreak
            self.identifierLookup = identifierLookup
            sdkNodesByClass = Dictionary(grouping: allSdkNodes, by: { classFamily($0.className) })
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
                in: geometryIndex,
                identifierLookup: identifierLookup,
                tieBreak: tieBreak
            )
            directCache[key] = result
            return result
        }

        /// Smallest enclosing SDK node for `bounds` (for SwiftUI views whose accessibility
        /// bounds differ from UIKit). Cached per bounds so identical-bounds siblings do not
        /// repeat the index query, including cached misses.
        func enclosingMatch(bounds: ElementBounds?) -> SdkViewNode? {
            guard let bounds else { return nil }
            let key = BoundsKey(left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom)
            if let cached = enclosingCache[key] { return cached }
            let enclosingID: NodeID? = geometryIndex.smallestEnclosingID(bounds: bounds)
            let result: SdkViewNode? = enclosingID.map { geometryIndex.allNodes[$0] }
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
    /// Strategy: (1) exact className + nearest bounds, (2) nearest bounds-only,
    /// (3) accessibilityIdentifier. Exact bounds naturally compete at distance zero.
    private static func findDirectMatch(
        className: String?,
        resourceId: String?,
        bounds: ElementBounds?,
        in index: GeometryIndex,
        identifierLookup: [String: SdkViewNode],
        tieBreak: ToleranceTieBreak
    )
        -> SdkViewNode?
    {
        if let bounds = bounds {
            // 1. Exact className + bounds within ±tolerance (not classFamily).
            if let className = className {
                if let near = index.nearest(bounds: bounds, className: className, tieBreak: tieBreak, accept: {
                    identifiersCompatible($0, resourceId)
                }) {
                    return near
                }
            }
            // 2. Bounds-only fallback: different class names at the same position.
            if let near = index.nearest(bounds: bounds, tieBreak: tieBreak, accept: {
                identifiersCompatible($0, resourceId)
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
