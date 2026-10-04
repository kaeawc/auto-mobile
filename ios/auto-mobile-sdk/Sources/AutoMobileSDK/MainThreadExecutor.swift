import Foundation
import os

/// UIKit work is inline on main and deferred for background callers.
protocol MainThreadExecuting: Sendable {
    func execute(_ work: @escaping @MainActor @Sendable () -> Void)
}

struct MainThreadExecutor: MainThreadExecuting {
    func execute(_ work: @escaping @MainActor @Sendable () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { work() }
        } else {
            DispatchQueue.main.async { work() }
        }
    }
}

/// Serializes resource callbacks on main and invalidates pending setup immediately.
/// A restart cleans up the previous installed generation before installing resources,
/// even if its queued teardown has not run yet. Callbacks execute without the state lock.
final class MainThreadLifecycle: Sendable {
    private struct State: Sendable {
        var generation: UInt64 = 0
        var active = false
        var cleanup: (@MainActor @Sendable () -> Void)?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let executor: any MainThreadExecuting

    init(executor: any MainThreadExecuting = MainThreadExecutor()) {
        self.executor = executor
    }

    var isActive: Bool { state.withLock { $0.active } }

    var isInstalled: Bool { state.withLock { $0.cleanup != nil } }

    /// Reserve before initialization releases its owner lock, so shutdown can
    /// invalidate setup even while the caller is still preparing other subsystems.
    func prepare() -> UInt64? {
        state.withLock { state in
            guard !state.active else { return nil }
            state.active = true
            state.generation &+= 1
            return state.generation
        }
    }

    func start(
        setup: @escaping @MainActor @Sendable () -> Void,
        teardown: @escaping @MainActor @Sendable () -> Void
    ) {
        guard let generation = prepare() else { return }
        schedule(generation: generation, setup: setup, teardown: teardown)
    }

    func schedule(
        generation: UInt64,
        setup: @escaping @MainActor @Sendable () -> Void,
        teardown: @escaping @MainActor @Sendable () -> Void
    ) {
        executor.execute {
            let installation = self.state.withLock { state -> (Bool, (@MainActor @Sendable () -> Void)?) in
                guard state.active, state.generation == generation else { return (false, nil) }
                let cleanup = state.cleanup
                state.cleanup = nil
                return (true, cleanup)
            }
            guard installation.0 else { return }
            installation.1?()
            guard self.state.withLock({ $0.active && $0.generation == generation }) else { return }
            setup()
            let retained = self.state.withLock { state in
                guard state.active, state.generation == generation else { return false }
                state.cleanup = teardown
                return true
            }
            // Shutdown can invalidate an installation while its setup is running.
            // Main serialization lets us clean it here before queued teardown runs.
            if !retained { teardown() }
        }
    }

    func stop() {
        let generation = state.withLock { state in
            state.active = false
            state.generation &+= 1
            return state.generation
        }
        executor.execute {
            let cleanup = self.state.withLock { state -> (@MainActor @Sendable () -> Void)? in
                guard state.generation == generation else { return nil }
                let cleanup = state.cleanup
                state.cleanup = nil
                return cleanup
            }
            cleanup?()
        }
    }
}
