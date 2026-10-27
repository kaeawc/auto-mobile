import Foundation

/// Geometry is shared only in the full profile; ordinary visibility handles reduced/off swaps.
struct PrototypeSharedElementPlan: Equatable {
    let key: String?
    let apply: Bool

    /// `conflictingKeys` are keys with more than one node shown right now (see `conflictingKeys`): a
    /// pair visible together has no source to match, so it keeps the ordinary visibility animation.
    init(node: PrototypeNode, profile: PrototypeMotionProfile, conflictingKeys: Set<String> = []) {
        key = node.sharedKey
        apply = profile == .full && node.visibleWhen != nil && key.map { !conflictingKeys.contains($0) } == true
    }

    /// Keys shown by more than one node under `holds`. Hidden nodes are not entered; screens of a
    /// stack are, since `sharedKey` is not supported across screens and only the shown pair matters.
    static func conflictingKeys(in root: PrototypeNode, holds: (Condition) -> Bool) -> Set<String> {
        var shown: [String: Int] = [:]
        func visit(_ node: PrototypeNode) {
            if let condition = node.visibleWhen, !holds(condition) { return }
            if let key = node.sharedKey { shown[key, default: 0] += 1 }
            node.children?.forEach(visit)
            if let child = node.child { visit(child) }
        }
        visit(root)
        return Set(shown.filter { $0.value > 1 }.keys)
    }

    /// Located nodes come from the structural validator's pre-order, sorted-field traversal.
    static func validate(_ nodes: [PrototypeLocatedValue], actions: [PrototypeLocatedValue] = []) throws {
        let sources = try PrototypeStackPatterns.sources(nodes, actions: actions)
        var repeats: [String] = []
        var pairs: [String: [String]] = [:]
        var order: [String] = []
        for node in nodes {
            if node.value["repeat"] != nil { repeats.append(node.path) }
            guard let key = node.value["sharedKey"]?.stringValue else { continue }
            let path = "\(node.path).sharedKey"
            func fail(_ message: String) -> PrototypeLoadError {
                PrototypeContractValidator.invalid(path, message)
            }
            guard node.value["visibleWhen"] != nil || sources.contains(key) else {
                throw fail("sharedKey requires visibleWhen on the same node")
            }
            if repeats.contains(where: { node.path == $0 || node.path.hasPrefix("\($0).") }) {
                throw fail("sharedKey is not allowed inside repeat templates")
            }
            if pairs[key] == nil { pairs[key] = []; order.append(key) }
            guard pairs.count <= 16 else { throw fail("a spec allows at most 16 sharedKey values") }
            let prior = pairs[key] ?? []
            guard prior.count < 2 else { throw fail("sharedKey \"\(key)\" must be used by exactly two nodes") }
            if prior.contains(where: { node.path.hasPrefix("\($0).") }) {
                throw fail("sharedKey nodes cannot be nested in each other")
            }
            pairs[key, default: []].append(node.path)
        }
        if let key = order.first(where: { pairs[$0]?.count == 1 && !sources.contains($0) }),
           let first = pairs[key]?.first
        {
            throw PrototypeContractValidator.invalid(
                "\(first).sharedKey", "sharedKey \"\(key)\" must be used by exactly two nodes"
            )
        }
    }
}
