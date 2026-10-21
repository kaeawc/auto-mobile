import Foundation

/// One on-screen instance of a view that reports a hit rect.
struct PrototypeHitRectOwner: Hashable, Sendable {
    private let id = UUID()
}

/// Keeps each view's rect until its own withdrawal, regardless of report order (#12207).
struct PrototypeHitRects: Sendable {
    private var entries: [String: [PrototypeHitRectOwner: CGRect]] = [:]

    func contains(_ point: CGPoint) -> Bool {
        entries.values.contains { $0.values.contains { $0.contains(point) } }
    }

    func layer(at point: CGPoint) -> PrototypeHostLayer? {
        var layer: PrototypeHostLayer?
        for (key, rects) in entries where rects.values.contains(where: { $0.contains(point) }) {
            if PrototypeHostLayer(hitRectKey: key) == .top { return .top }
            layer = .page
        }
        return layer
    }

    mutating func report(_ rect: CGRect?, key: String, owner: PrototypeHitRectOwner) {
        guard let rect else {
            withdraw(key: key, owner: owner)
            return
        }
        entries[key, default: [:]][owner] = rect
    }

    mutating func withdraw(key: String, owner: PrototypeHitRectOwner) {
        entries[key]?[owner] = nil
        if entries[key]?.isEmpty == true { entries[key] = nil }
    }

    mutating func removeAll() {
        entries.removeAll()
    }
}
