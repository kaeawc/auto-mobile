import Foundation

/// Geometry is shared only in the full profile; ordinary visibility handles reduced/off swaps.
struct PrototypeSharedElementPlan: Equatable {
    let key: String?
    let apply: Bool
    let crossfade: Bool

    /// `conflictingKeys` are keys with more than one node shown right now (see `conflictingKeys`): a
    /// pair visible together has no source to match, so it keeps the ordinary visibility animation.
    init(node: PrototypeNode, profile: PrototypeMotionProfile, conflictingKeys: Set<String> = []) {
        key = node.resolvedSharedKey
        crossfade = profile != .off && (profile == .reduced || node.shared?.as != "element")
        apply = profile == .full && node.visibleWhen != nil && key.map { !conflictingKeys.contains($0) } == true
    }

    /// Keys shown by more than one node under `holds`. Hidden nodes are not entered; screens of a
    /// stack are, since `sharedKey` is not supported across screens and only the shown pair matters.
    static func conflictingKeys(in root: PrototypeNode, holds: (Condition) -> Bool) -> Set<String> {
        var shown: [String: Int] = [:]
        func visit(_ node: PrototypeNode) {
            if let condition = node.visibleWhen, !holds(condition) { return }
            if let key = node.resolvedSharedKey { shown[key, default: 0] += 1 }
            node.children?.forEach(visit)
            if let child = node.child { visit(child) }
        }
        visit(root)
        return Set(shown.filter { $0.value > 1 }.keys)
    }

    /// Located nodes come from the structural validator's pre-order traversal.
    static func validate(_ nodes: [PrototypeLocatedValue], data: [String: JSONValue]? = nil) throws {
        try PrototypeSharedElementRules.validate(nodes, data: data)
    }
}
