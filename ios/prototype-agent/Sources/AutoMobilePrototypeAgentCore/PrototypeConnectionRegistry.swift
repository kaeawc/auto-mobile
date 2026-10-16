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
