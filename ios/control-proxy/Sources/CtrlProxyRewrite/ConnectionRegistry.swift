import Foundation
import os

/// Registry of active connections keyed by connection id.
///
/// Connect/disconnect run on the server queue, but broadcasts iterate the
/// connections on another thread (hierarchy debouncer + CADisplayLink FPS
/// callbacks), so a plain `Dictionary` mutated on one thread while iterated on
/// another is UB (issue #3611). The reference guarded this with `NSLock`; the
/// rewrite holds an `OSAllocatedUnfairLock<[Int: Value]>`, making the type genuinely
/// `Sendable` (no `@unchecked`). Iteration is still over a copied snapshot taken
/// under the lock, and the snapshot stays **synchronous** so the main-thread
/// broadcast path never has to `await` (why this is a lock, not an actor).
final class ConnectionRegistry<Value: Sendable>: Sendable {
    private let synchronizedStorage = OSAllocatedUnfairLock<[Int: Value]>(initialState: [:])

    func set(_ value: Value, forId id: Int) {
        synchronizedStorage.withLock { $0[id] = value }
    }

    func removeValue(forId id: Int) {
        synchronizedStorage.withLock { $0[id] = nil }
    }

    func value(forId id: Int) -> Value? {
        synchronizedStorage.withLock { $0[id] }
    }

    /// Snapshot copy of all current values, safe to iterate outside the lock.
    func values() -> [Value] {
        synchronizedStorage.withLock { Array($0.values) }
    }

    var count: Int {
        synchronizedStorage.withLock { $0.count }
    }

    var isEmpty: Bool {
        synchronizedStorage.withLock { $0.isEmpty }
    }

    /// Atomically clears the registry, returning the values that were removed.
    func removeAll() -> [Value] {
        synchronizedStorage.withLock { storage in
            let all = Array(storage.values)
            storage.removeAll(keepingCapacity: true)
            return all
        }
    }
}
