@testable import CtrlProxy
import Foundation
import os

final class FakeTimeProvider: TimeProvider {
    private let time: OSAllocatedUnfairLock<Int64>

    init(initialTime: Int64 = 0) {
        time = OSAllocatedUnfairLock(initialState: initialTime)
    }

    func currentTimeMillis() -> Int64 {
        time.withLock { $0 }
    }

    /// Set the current time to a specific value.
    func setTime(_ newTime: Int64) {
        time.withLock { $0 = newTime }
    }

    /// Advance time by the specified number of milliseconds.
    func advance(by milliseconds: Int64) {
        time.withLock { $0 += milliseconds }
    }

    /// Reset time to zero.
    func reset() {
        time.withLock { $0 = 0 }
    }
}
