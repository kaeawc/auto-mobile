@testable import CtrlProxy
import Foundation
import os

final class FakeProxyTimer: ProxyTimer {
    enum Mode: Sendable {
        case instant // All waits complete immediately.
        case manual // Waits only complete when manually advanced.
        case delayed(Int64) // Each wait takes a fixed real duration.
    }

    private struct State {
        var currentTime: Int64
        var pendingCallbacks: [(time: Int64, callback: @Sendable () -> Void)] = []
        var pendingWaiters: [(id: UUID, time: Int64, continuation: CheckedContinuation<Void, Never>)] = []
        var cancelledWaits = 0
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
            guard milliseconds > 0 else { return }
            let id = UUID()
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    let cancelled = state.withLock { value -> Bool in
                        if Task.isCancelled { return true }
                        value.pendingWaiters.append((id, value.currentTime + milliseconds, continuation))
                        return false
                    }
                    if cancelled { continuation.resume() }
                }
            } onCancel: {
                let waiter = self.state.withLock { value -> CheckedContinuation<Void, Never>? in
                    value.cancelledWaits += 1
                    guard let index = value.pendingWaiters.firstIndex(where: { $0.id == id }) else { return nil }
                    return value.pendingWaiters.remove(at: index).continuation
                }
                waiter?.resume()
            }

        case let .delayed(delay):
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            state.withLock { $0.currentTime += milliseconds }
        }
    }

    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) {
        state.withLock { value in
            let targetTime = value.currentTime + milliseconds
            value.pendingCallbacks.append((time: targetTime, callback: callback))
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
        ) = state.withLock { value in
            value.currentTime += milliseconds
            let due = value.pendingCallbacks.filter { $0.time <= value.currentTime }
            value.pendingCallbacks.removeAll { $0.time <= value.currentTime }
            let waiters = value.pendingWaiters.filter { $0.time <= value.currentTime }.map(\.continuation)
            value.pendingWaiters.removeAll { $0.time <= value.currentTime }
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
        let waiters: [CheckedContinuation<Void, Never>] = state.withLock { value in
            value.currentTime = 0
            value.pendingCallbacks.removeAll()
            let waiters = value.pendingWaiters.map(\.continuation)
            value.pendingWaiters.removeAll()
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

    var cancelledWaitCount: Int { state.withLock { $0.cancelledWaits } }

    /// Count of pending waiters.
    var pendingWaiterCount: Int {
        state.withLock { $0.pendingWaiters.count }
    }
}
