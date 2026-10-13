import Foundation

/// One on-screen instance of a view that reports a hit rect.
struct PrototypeHitRectOwner: Hashable, Sendable {
    private let id = UUID()
}

/// Remembers the last reporter so an outgoing branch cannot clear its replacement's rect (#12207).
struct PrototypeHitRects: Sendable {
    private struct Entry: Sendable {
        let rect: CGRect
        let owner: PrototypeHitRectOwner
    }

    private var entries: [String: Entry] = [:]

    var rects: [String: CGRect] { entries.mapValues(\.rect) }

    func contains(_ point: CGPoint) -> Bool {
        entries.values.contains { $0.rect.contains(point) }
    }

    mutating func report(_ rect: CGRect?, key: String, owner: PrototypeHitRectOwner) {
        guard let rect else {
            withdraw(key: key, owner: owner)
            return
        }
        entries[key] = Entry(rect: rect, owner: owner)
    }

    mutating func withdraw(key: String, owner: PrototypeHitRectOwner) {
        guard entries[key]?.owner == owner else { return }
        entries[key] = nil
    }

    mutating func removeAll() {
        entries.removeAll()
    }
}
