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

    static func hasSource(in node: PrototypeNode) -> Bool {
        node.resolvedSharedKey != nil || node.childEntries(path: "root").contains { hasSource(in: $0.node) }
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
