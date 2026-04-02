import Foundation

/// Reason an event was dropped by the SDK.
public enum DropReason: String, Codable, Sendable, CaseIterable {
    case disabled
    case shutdown
    case flushError
    case bufferOverflow
    case filtered
    case deliveryFailed
}

/// Tracks dropped event counts by reason.
protocol DropCounting: AnyObject, Sendable {
    func increment(_ reason: DropReason)
    func increment(_ reason: DropReason, count: Int)
    func snapshot() -> [DropReason: Int]
    func reset()
}

extension DropCounting {
    func increment(_ reason: DropReason, count: Int) {
        for _ in 0..<count {
            increment(reason)
        }
    }
}

/// Thread-safe default implementation of ``DropCounting``.
final class DefaultDropCounter: DropCounting, @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [DropReason: Int] = [:]

    init() {}

    func increment(_ reason: DropReason) {
        lock.lock()
        counts[reason, default: 0] += 1
        lock.unlock()
    }

    func increment(_ reason: DropReason, count: Int) {
        lock.lock()
        counts[reason, default: 0] += count
        lock.unlock()
    }

    func snapshot() -> [DropReason: Int] {
        lock.lock()
        defer { lock.unlock() }
        return counts
    }

    func reset() {
        lock.lock()
        counts.removeAll()
        lock.unlock()
    }
}
