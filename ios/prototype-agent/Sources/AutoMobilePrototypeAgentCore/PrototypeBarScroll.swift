import Foundation

/// Transient Material bar geometry, in points. Positive scroll deltas move content upwards.
struct PrototypeBarScrollState: Equatable {
    var hidden = false
    var offset = 0.0
    var travel = 0.0

    mutating func update(offset next: Double, extent: Double = 64) {
        let clamped = max(0, next)
        if clamped != offset { hidden = clamped > offset }
        travel = min(extent, max(0, travel + clamped - offset))
        offset = clamped
    }

    static func extent(variant: String?, behavior: String?) -> Double {
        let extra = variant == "large" ? 88.0 : (variant == "medium" ? 48.0 : 0.0)
        return behavior == "enterAlways" ? 64 + extra : (behavior == "exitUntilCollapsed" ? max(1, extra) : 64)
    }

    func collapse(_ behavior: String?, extent: Double, reduced: Bool) -> Double {
        guard behavior != nil, behavior != "pinned", behavior != "none" else { return 0 }
        let distance = behavior == "exitUntilCollapsed" ? offset : travel
        let fraction = min(1, max(0, distance / max(1, extent)))
        if reduced { return behavior == "exitUntilCollapsed" ? (offset > 0 ? 1 : 0) : (hidden ? 1 : 0) }
        return fraction
    }
}

struct PrototypeNodeSafeInsets {
    let navInsets: PrototypeSafeInsets
    let styledInsets: PrototypeSafeInsets

    init(nodeType: String, safeInsets: PrototypeSafeInsets) {
        let isBottomNav = nodeType == "bottomNav"
        navInsets = isBottomNav ? safeInsets : PrototypeSafeInsets()
        styledInsets = isBottomNav ? PrototypeSafeInsets() : safeInsets
    }

    func navigationSizing(showsLabel: Bool)
        -> (itemMinHeight: CGFloat, containerMinHeight: CGFloat, topPadding: CGFloat, bottomPadding: CGFloat)
    {
        PrototypeBarScroll.navigationSizing(showsLabel: showsLabel, safeInsets: navInsets)
    }
}

enum PrototypeBarScroll {
    static func showsNavigationLabel(behavior: String?, fraction: Double) -> Bool {
        behavior != "minimize" || fraction <= 0
    }

    static func navigationSizing(showsLabel: Bool, safeInsets: PrototypeSafeInsets = PrototypeSafeInsets())
        -> (itemMinHeight: CGFloat, containerMinHeight: CGFloat, topPadding: CGFloat, bottomPadding: CGFloat)
    {
        let itemHeight: CGFloat = showsLabel ? 64 : 56
        let topPadding: CGFloat = (showsLabel ? 12 : 0) + safeInsets.top
        let bottomPadding: CGFloat = (showsLabel ? 4 : 0) + safeInsets.bottom
        return (itemHeight, itemHeight + topPadding + bottomPadding, topPadding, bottomPadding)
    }

    static func validate(_ root: JSONValue) throws {
        try screen(root, path: "root")
    }

    private static func screen(_ root: JSONValue, path: String) throws {
        var nodes: [(value: [String: JSONValue], path: String)] = []
        var screens: [(JSONValue, String)] = []
        func visit(_ value: JSONValue, _ location: String) {
            guard let node = value.objectFields else { return }
            nodes.append((node, location))
            if let child = node["child"] { visit(child, "\(location).child") }
            if case let .array(children) = node["children"] {
                for (index, child) in children.enumerated() {
                    visit(child, "\(location).children[\(index)]")
                }
            }
            screens += PrototypeStacks.screenChildren(in: node, path: location).map { ($0.0, $0.1) }
        }
        visit(root, path)
        for (node, location) in nodes
            where ["topAppBar", "bottomNav", "tabBar"].contains(node["type"]?.stringValue ?? "")
        {
            let active = node["onScroll"] != nil && !["pinned", "none"].contains(node["onScroll"]?.stringValue ?? "")
            if node["scroll"] == nil, !active { continue }
            let target = node["scroll"]?.stringValue
            let count = nodes.filter { $0.value["type"] == .string("scroll") && $0.value["id"]?.stringValue == target }
                .count
            guard target != nil, count == 1 else {
                throw PrototypeContractValidator.invalid(
                    "\(location).scroll",
                    "Expected one scroll id in the same screen"
                )
            }
        }
        for (value, location) in screens {
            try screen(value, path: location)
        }
    }
}
