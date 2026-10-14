import Foundation

enum PrototypeLifecycleMode: Equatable {
    case session
    case standalone
}

extension PrototypeLifecycleMode {
    var expiresWhenIdle: Bool { self == .session }
    var endsWithHost: Bool { self == .session }
    var buffersOffline: Bool { self == .standalone }

    static let persistenceReplayCapability = "prototype_persistence_replay_v1"

    func advertising(_ capabilities: [String]) -> [String] {
        guard buffersOffline, !capabilities.contains(Self.persistenceReplayCapability) else { return capabilities }
        return capabilities + [Self.persistenceReplayCapability]
    }
}

let prototypeOfflineEventCapacity = 200

/// Fixed-size ring: overflow replaces the oldest event without shifting the remaining events.
struct PrototypeOfflineEventBuffer<Element> {
    private var elements: [Element?]
    private var head = 0
    private(set) var count = 0
    /// Cumulative overflow count, including events lost before an earlier drain.
    private(set) var dropped = 0

    init(capacity: Int = prototypeOfflineEventCapacity) {
        precondition(capacity > 0, "Prototype offline event capacity must be positive")
        elements = Array(repeating: nil, count: capacity)
    }

    mutating func add(_ e: Element) {
        if count == elements.count {
            elements[head] = e
            head = (head + 1) % elements.count
            dropped += 1
        } else {
            elements[(head + count) % elements.count] = e
            count += 1
        }
    }

    mutating func drain() -> [Element] {
        var events: [Element] = []
        events.reserveCapacity(count)
        for offset in 0 ..< count {
            let index = (head + offset) % elements.count
            if let event = elements[index] { events.append(event) }
            elements[index] = nil
        }
        head = 0
        count = 0
        return events
    }
}

/// The main-actor agent owns this outbox and broadcasts each returned event in order.
struct PrototypeEventOutbox<Element> {
    let mode: PrototypeLifecycleMode
    private var buffer: PrototypeOfflineEventBuffer<Element>
    private(set) var clients = 0
    var droppedEvents: Int { buffer.dropped }
    var bufferedCount: Int { buffer.count }

    init(mode: PrototypeLifecycleMode, capacity: Int = prototypeOfflineEventCapacity) {
        self.mode = mode
        buffer = PrototypeOfflineEventBuffer(capacity: capacity)
    }

    mutating func publish(_ e: Element) -> [Element] {
        guard mode.buffersOffline else { return [e] }
        guard clients > 0 else {
            buffer.add(e)
            return []
        }
        return buffer.drain() + [e]
    }

    mutating func clientCountChanged(_ n: Int) -> [Element] {
        clients = n
        return mode.buffersOffline && n > 0 ? buffer.drain() : []
    }

    mutating func drainForInspect() -> [Element] {
        mode.buffersOffline ? buffer.drain() : []
    }
}
