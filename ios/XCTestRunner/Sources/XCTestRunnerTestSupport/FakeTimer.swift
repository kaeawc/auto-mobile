import Foundation
import os
import XCTestRunnerRewrite

/// Deterministic test timer: `now()` returns a controllable clock and `sleep` advances it (recording
/// each interval) instead of blocking. Relocated out of the shipping target (the reference shipped it
/// in the product). `AutoMobileTimer` now refines `Sendable`, so the mutable state is lock-confined
/// (`OSAllocatedUnfairLock`) rather than a bare `var` — cleanly `Sendable`, no `@unchecked`.
public final class FakeTimer: AutoMobileTimer {
    private struct State: Sendable {
        var currentTime: TimeInterval
        var sleeps: [TimeInterval] = []
    }

    private let state: OSAllocatedUnfairLock<State>

    public init(initialTime: TimeInterval = 0) {
        state = OSAllocatedUnfairLock(initialState: State(currentTime: initialTime))
    }

    public var currentTime: TimeInterval { state.withLock { $0.currentTime } }
    public var sleeps: [TimeInterval] { state.withLock { $0.sleeps } }

    public func now() -> TimeInterval {
        state.withLock { $0.currentTime }
    }

    public func sleep(seconds: TimeInterval) {
        state.withLock {
            $0.sleeps.append(seconds)
            $0.currentTime += seconds
        }
    }
}
