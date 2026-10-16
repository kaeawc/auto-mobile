/// The authenticated connections in the order they authenticated. A host-proxied request goes to
/// exactly one of them, the most recently authenticated (`current`), so a reconnecting daemon
/// replaces the connection it superseded and a side-effecting request is never run twice. This
/// mirrors Android's `WebSocketServer.sendToHost` (#12528).
struct PrototypeConnectionRegistry<ID: Hashable>: Equatable {
    private var order: [ID] = []

    /// Every authenticated connection, oldest first (events are broadcast to all of them).
    var all: [ID] { order }

    /// The connection a host request goes to; `nil` when none is authenticated.
    var current: ID? { order.last }

    /// Authenticating again moves the connection to the most recent position.
    mutating func register(_ id: ID) {
        order.removeAll { $0 == id }
        order.append(id)
    }

    mutating func unregister(_ id: ID) {
        order.removeAll { $0 == id }
    }
}

/// Which connection each host-proxied request went to. A request is routed to the registry's
/// `current` connection and remembered, so when that connection closes its requests fail at once
/// (`network`) instead of waiting for a watchdog, while requests owned by other connections are
/// untouched.
struct PrototypeHostRouting<ID: Hashable>: Equatable {
    private var registry = PrototypeConnectionRegistry<ID>()
    private var owners: [String: ID] = [:]

    /// Every authenticated connection, oldest first.
    var all: [ID] { registry.all }

    mutating func authenticate(_ id: ID) { registry.register(id) }

    /// The connection `requestId` is sent to and now belongs to; `nil` when none is authenticated.
    mutating func route(_ requestId: String) -> ID? {
        guard let id = registry.current else { return nil }
        owners[requestId] = id
        return id
    }

    /// The request ended (answered, timed out or cancelled): forget its owner.
    mutating func finish(_ requestId: String) { owners[requestId] = nil }

    /// The connection closed: the requests it owned, sorted, which can no longer be answered.
    mutating func disconnect(_ id: ID) -> [String] {
        registry.unregister(id)
        let lost = owners.filter { $0.value == id }.map(\.key).sorted()
        for requestId in lost {
            owners[requestId] = nil
        }
        return lost
    }
}
