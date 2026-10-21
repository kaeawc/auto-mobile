import Foundation

/// `scroll.refresh` (`prototype_refresh_v1`): the indicator shows while the boolean `stateKey` is
/// true. A pull writes true to it and runs `onRefresh`; the prototype or a patch writes false.
struct PrototypeScrollRefresh: Decodable {
    let stateKey: String
    let onRefresh: [PrototypeAction]
}

enum PrototypeRefresh {
    /// What a pull runs: the key is set first so the indicator shows, then the authored actions.
    static func actions(for refresh: PrototypeScrollRefresh) -> [PrototypeAction] {
        [
            PrototypeAction(
                type: "setState", name: nil, payload: nil, context: nil, pager: nil, page: nil,
                stack: nil, screen: nil, path: nil, key: refresh.stateKey, value: .bool(true), by: nil,
                requireValid: nil
            ),
        ] + refresh.onRefresh
    }

    /// A horizontal scroll cannot pull to refresh; matches the host and Android validators.
    static func validate(_ root: JSONValue) throws {
        try visit(root, path: "root")
    }

    private static func visit(_ value: JSONValue, path: String) throws {
        guard case let .object(node) = value else { return }
        if node["type"] == .string("scroll"), node["refresh"] != nil, node["axis"] == .string("horizontal") {
            throw DecodingError.dataCorrupted(.init(
                codingPath: [], debugDescription: "\(path).refresh: Pull-to-refresh needs a vertical scroll"
            ))
        }
        if case let .array(children)? = node["children"] {
            for (index, child) in children.enumerated() {
                try visit(child, path: "\(path).children[\(index)]")
            }
        }
        if let child = node["child"] { try visit(child, path: "\(path).child") }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: node, path: path) {
            try visit(screen, path: screenPath)
        }
    }

    /// The refreshable closure stays open until the key is false again, which is what keeps the
    /// system indicator spinning. `sleep` and `isRefreshing` are injected so tests run instantly.
    @MainActor
    static func awaitCompletion(
        isRefreshing: () -> Bool,
        isCancelled: () -> Bool,
        sleep: () async -> Void
    )
        async
    {
        while isRefreshing(), !isCancelled() {
            await sleep()
        }
    }
}
