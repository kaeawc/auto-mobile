import Foundation
import os

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
        for _ in 0 ..< count {
            increment(reason)
        }
    }
}

/// Thread-safe default implementation of ``DropCounting``.
final class DefaultDropCounter: DropCounting, Sendable {
    private let counts = OSAllocatedUnfairLock<[DropReason: Int]>(initialState: [:])

    init() {}

    func increment(_ reason: DropReason) {
        counts.withLock { $0[reason, default: 0] += 1 }
    }

    func increment(_ reason: DropReason, count: Int) {
        counts.withLock { $0[reason, default: 0] += count }
    }

    func snapshot() -> [DropReason: Int] {
        counts.withLock { $0 }
    }

    func reset() {
        counts.withLock { $0.removeAll() }
    }
}
