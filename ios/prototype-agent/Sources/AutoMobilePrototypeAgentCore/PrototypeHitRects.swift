import Foundation
import Observation

/// One on-screen instance of a view that reports a hit rect.
struct PrototypeHitRectOwner: Hashable, Sendable {
    private let id = UUID()
}

/// Keeps each view's rect until its own withdrawal, regardless of report order (#12207).
@Observable
final class PrototypeHitRects {
    @ObservationIgnored private var entries: [String: [PrototypeHitRectOwner: CGRect]] = [:]
    /// Only content geometry drives layout; touch-only reports must not invalidate modal views.
    private(set) var contentFrame: CGRect?

    func contains(_ point: CGPoint) -> Bool {
        entries.values.contains { $0.values.contains { $0.contains(point) } }
    }

    /// The reported rect for `key` (the union when several views share it), nil when none is on screen.
    func rect(key: String) -> CGRect? {
        if key == "content" { return contentFrame }
        return reportedRect(key: key)
    }

    private func reportedRect(key: String) -> CGRect? {
        entries[key]?.values.reduce(nil) { union, rect in union.map { $0.union(rect) } ?? rect }
    }

    private func syncContentFrame(for key: String) {
        guard key == "content" else { return }
        let next = reportedRect(key: key)
        if contentFrame != next { contentFrame = next }
    }

    func layer(at point: CGPoint) -> PrototypeHostLayer? {
        var layer: PrototypeHostLayer?
        for (key, rects) in entries where rects.values.contains(where: { $0.contains(point) }) {
            if PrototypeHostLayer(hitRectKey: key) == .top { return .top }
            layer = .page
        }
        return layer
    }

    func report(_ rect: CGRect?, key: String, owner: PrototypeHitRectOwner) {
        guard let rect else {
            withdraw(key: key, owner: owner)
            return
        }
        entries[key, default: [:]][owner] = rect
        syncContentFrame(for: key)
    }

    func withdraw(key: String, owner: PrototypeHitRectOwner) {
        entries[key]?[owner] = nil
        if entries[key]?.isEmpty == true { entries[key] = nil }
        syncContentFrame(for: key)
    }

    func removeAll() {
        entries.removeAll()
        if contentFrame != nil { contentFrame = nil }
    }
}
