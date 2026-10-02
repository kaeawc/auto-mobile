import Foundation
import os

/// FIFO ownership without occupying an executor thread. A cancelled queued cell is removed; a
/// grant racing cancellation is released by acquire's cancellation check. Holders use defer/release.
final class AsyncSerialGate: Sendable {
    private struct State: Sendable {
        var held = false
        var waiters: [SingleResumeCell<Void>] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let onQueued: @Sendable () -> Void

    /// An optional event seam lets tests synchronize on actual enqueue, rather than scheduling guesses.
    init(onQueued: @escaping @Sendable () -> Void = {}) { self.onQueued = onQueued }

    func acquire() async throws {
        try Task.checkCancellation()
        let waiter = SingleResumeCell<Void>()
        try await withTaskCancellationHandler {
            let (queued, granted) = state.withLock { current -> (Bool, Bool) in
                // onCancel may have removed the waiter before its out-of-lock cell cancellation.
                // The task flag closes that registration window without resuming under this lock.
                guard !Task.isCancelled, !waiter.isResolved else { return (false, false) }
                if current.held {
                    current.waiters.append(waiter)
                    return (true, false)
                } else {
                    current.held = true
                    return (false, true)
                }
            }
            if granted, !waiter.resume(returning: ()) { release() }
            if queued { onQueued() }
            try await waiter.wait(cancellable: false)
        } onCancel: {
            self.state.withLock { current in
                current.waiters.removeAll { $0 === waiter }
            }
            waiter.cancel()
        }
        do {
            try Task.checkCancellation()
        } catch {
            release()
            throw error
        }
    }

    func release() {
        while true {
            let next = state.withLock { current -> SingleResumeCell<Void>? in
                while !current.waiters.isEmpty {
                    let waiter = current.waiters.removeFirst()
                    if !waiter.isResolved { return waiter }
                }
                current.held = false
                return nil
            }
            // Ownership stays reserved until a live waiter accepts it. If cancellation wins
            // after the pop, hand that reservation on without resuming under the gate lock.
            guard let next else { return }
            if next.resume(returning: ()) { return }
        }
    }
}
