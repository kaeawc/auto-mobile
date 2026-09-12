@testable import CtrlProxyRewrite
import Foundation
import os

/// Test double for `ProxyTimer` supporting instant / manual / delayed modes. The
/// reference guarded four mutable fields with an `NSLock` and was `@unchecked
/// Sendable`; the rewrite folds that state into an `OSAllocatedUnfairLock<State>`, so
/// the fake is genuinely `Sendable`. As in the reference, scheduled callbacks and
/// resumed waiters run OUTSIDE the lock so a callback that re-enters the timer cannot
/// deadlock.
///
/// Named `FakeProxyTimer` (not `FakeTimer`) so the differential-parity drivers can name
/// the REFERENCE module's public `FakeTimer` unqualified: the reference module also
/// exports a `public class CtrlProxy` type that shadows the module name, so
/// `CtrlProxy.FakeTimer` parses as member access on that type and fails — leaving an
/// unshadowed `FakeTimer` in the test target as the only way to reach the reference fake.
final class FakeProxyTimer: ProxyTimer {
    enum Mode: Sendable {
        case instant // All waits complete immediately.
        case manual // Waits only complete when manually advanced.
        case delayed(Int64) // Each wait takes a fixed real duration.
    }

    private struct State {
        var currentTime: Int64
        var pendingCallbacks: [(time: Int64, callback: @Sendable () -> Void)] = []
        var pendingWaiters: [CheckedContinuation<Void, Never>] = []
    }

    private let mode: Mode
    private let state: OSAllocatedUnfairLock<State>

    init(mode: Mode = .instant, initialTime: Int64 = 0) {
        self.mode = mode
        state = OSAllocatedUnfairLock(initialState: State(currentTime: initialTime))
    }

    func now() -> Int64 {
        state.withLock { $0.currentTime }
    }

    func wait(milliseconds: Int64) async {
        switch mode {
        case .instant:
            state.withLock { $0.currentTime += milliseconds }

        case .manual:
            await withCheckedContinuation { continuation in
                state.withLock { $0.pendingWaiters.append(continuation) }
            }

        case let .delayed(delay):
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            state.withLock { $0.currentTime += milliseconds }
        }
    }

    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) {
        state.withLock { s in
            let targetTime = s.currentTime + milliseconds
            s.pendingCallbacks.append((time: targetTime, callback: callback))
        }
        if case .instant = mode {
            advance(by: milliseconds)
        }
    }

    /// Advance time by the specified number of milliseconds, firing any due scheduled
    /// callbacks (in time order) and resuming any pending waiters — both OUTSIDE the lock.
    func advance(by milliseconds: Int64) {
        let (toExecute, waiters): (
            [(time: Int64, callback: @Sendable () -> Void)],
            [CheckedContinuation<Void, Never>]
        ) = state.withLock { s in
            s.currentTime += milliseconds
            let due = s.pendingCallbacks.filter { $0.time <= s.currentTime }
            s.pendingCallbacks.removeAll { $0.time <= s.currentTime }
            let waiters = s.pendingWaiters
            s.pendingWaiters.removeAll()
            return (due, waiters)
        }

        for item in toExecute.sorted(by: { $0.time < $1.time }) {
            item.callback()
        }
        for waiter in waiters {
            waiter.resume()
        }
    }

    /// Set the current time to a specific value.
    func setTime(_ newTime: Int64) {
        state.withLock { $0.currentTime = newTime }
    }

    /// Reset time to zero, clear pending callbacks, and resume any pending waiters.
    func reset() {
        let waiters: [CheckedContinuation<Void, Never>] = state.withLock { s in
            s.currentTime = 0
            s.pendingCallbacks.removeAll()
            let waiters = s.pendingWaiters
            s.pendingWaiters.removeAll()
            return waiters
        }
        for waiter in waiters {
            waiter.resume()
        }
    }

    /// Count of pending scheduled callbacks.
    var pendingCallbackCount: Int {
        state.withLock { $0.pendingCallbacks.count }
    }

    /// Count of pending waiters.
    var pendingWaiterCount: Int {
        state.withLock { $0.pendingWaiters.count }
    }
}
