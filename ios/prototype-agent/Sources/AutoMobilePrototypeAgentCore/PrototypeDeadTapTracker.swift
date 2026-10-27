import Foundation

/// One pointer stream. The caller supplies window-local points; no clocks or UIKit are needed.
struct PrototypeDeadTapTracker {
    private let slop: Double
    private var origin: (x: Double, y: Double)?
    private var rejected = false

    init(slop: Double = 10) {
        self.slop = slop
    }

    mutating func begin(x: Double, y: Double) {
        guard origin == nil else {
            rejected = true
            return
        }
        origin = (x, y)
        rejected = false
    }

    mutating func move(x: Double, y: Double) {
        guard let origin else { return }
        if hypot(x - origin.x, y - origin.y) >= slop { rejected = true }
    }

    mutating func consume() { rejected = true }

    mutating func cancel() {
        origin = nil
        rejected = true
    }

    mutating func finish() -> Bool {
        defer { origin = nil }
        return origin != nil && !rejected
    }
}
