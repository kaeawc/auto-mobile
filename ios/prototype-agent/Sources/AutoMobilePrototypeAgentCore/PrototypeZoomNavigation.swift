import Foundation

/// Native zoom is an OS-dependent rendering promise, independent of acceptance of the vocabulary.
enum PrototypeZoomNavigation {
    enum Rendering: Equatable { case zoom, push, crossfade, instant }

    static func resolve(
        osMajor: Int,
        profile: PrototypeMotionProfile,
        transition: PrototypeStackTransition
    )
        -> Rendering
    {
        if profile == .off || transition == .none { return .instant }
        if profile == .reduced || transition == .fade { return .crossfade }
        return osMajor >= 18 && transition == .zoom ? .zoom : .push
    }

    static func hasZoom(in node: PrototypeNode, root: PrototypeNode) -> Bool {
        var nodes: [PrototypeNode] = []
        var actions: [PrototypeAction] = []
        PrototypeStateValidator.collect(root, nodes: &nodes, actions: &actions)
        return actions.flatMap(\.flattened).contains {
            ["push", "replace"].contains($0.type) && $0.stack == node.id &&
                ($0.transition ?? PrototypeStackTransition(rawValue: node.transition ?? "")) == .zoom
        }
    }

    static func destinations(_ entries: [PrototypeStackEntry]) -> [PrototypeStackEntry] {
        entries.dropFirst().filter { $0.zoomSource != nil }
    }

    /// A native dismissal removes the dismissed segment, including composed screens on top of it.
    /// The root is always the first model entry; replacing it never retains a removed origin.
    static func popCount(_ entries: [PrototypeStackEntry], keeping next: [PrototypeStackEntry]) -> Int {
        let destinations = destinations(entries)
        guard next.count < destinations.count, next == Array(destinations.prefix(next.count)),
              let destination = next.last ?? entries.first,
              let index = entries.firstIndex(where: { $0.id == destination.id }) else { return 0 }
        return entries.count - index - segment(entries, startingAt: destination).count
    }

    /// Consecutive non-zoom screens stay in the existing renderer. Only a zoom entry opens a
    /// native navigation destination, so mixed stacks retain their composed motion patterns.
    static func segment(
        _ entries: [PrototypeStackEntry],
        startingAt entry: PrototypeStackEntry
    )
        -> [PrototypeStackEntry]
    {
        guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return [entry] }
        let tail = entries.dropFirst(index + 1).prefix(while: { $0.zoomSource == nil })
        return [entries[index]] + tail
    }
}
