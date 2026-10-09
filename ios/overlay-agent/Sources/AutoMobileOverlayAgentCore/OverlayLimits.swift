import Foundation

/// Backstop for the structural limits the host validator enforces, mirroring Android's
/// `guardOverlayTree`. A spec that reaches the agent without the host check (a direct client)
/// cannot exhaust it: the tree is bounded before `repeat` expansion allocates anything.
///
/// The constants repeat `schemas/overlay-spec-contract.json`; `OverlayLimitsTests` fails when they
/// drift from it.
enum OverlayLimits {
    static let maxNodes = 2000
    static let maxDepth = 24
    static let maxRepeatItems = 128

    /// Throws the first limit the tree breaks. `repeat` templates count once per instance, in the
    /// same traversal order and path spelling as the Android guard (`root.repeat[1].children[0]`).
    static func guardTree(_ root: JSONValue) throws {
        var count = 0
        try visit(root, path: "root", depth: 1, count: &count)
    }

    private static func visit(_ node: JSONValue, path: String, depth: Int, count: inout Int) throws {
        guard case let .object(fields) = node else { return }
        count += 1
        if count > maxNodes { throw violation(path, "Node limit exceeded") }
        if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
        if case let .array(children)? = fields["children"] {
            if case let .object(spec)? = fields["repeat"] {
                guard case let .array(items)? = spec["items"] else { return }
                if items
                    .count > maxRepeatItems { throw violation("\(path).repeat.items", "Repeat item limit exceeded") }
                for item in items.indices {
                    for (index, child) in children.enumerated() {
                        try visit(
                            child,
                            path: "\(path).repeat[\(item)].children[\(index)]",
                            depth: depth + 1,
                            count: &count
                        )
                    }
                }
            } else {
                for (index, child) in children.enumerated() {
                    try visit(child, path: "\(path).children[\(index)]", depth: depth + 1, count: &count)
                }
            }
        }
        if let child = fields["child"] {
            try visit(child, path: "\(path).child", depth: depth + 1, count: &count)
        }
    }

    private static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }
}
