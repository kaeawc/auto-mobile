import Foundation
import os

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
