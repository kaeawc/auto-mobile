import Foundation
import os

/// Protocol for tracking user sessions based on app lifecycle.
protocol SessionTracking: AnyObject, Sendable {
    func currentSessionId() -> String?
    func onForeground()
    func onBackground()
    func shutdown()
}

/// Tracks user sessions based on app lifecycle.
/// A new session starts on first foreground or after timeout while backgrounded.
final class SessionTracker: SessionTracking, Sendable {
    enum State: Sendable { case active, backgrounded, ended }

    private struct LockedState: Sendable {
        var sessionId: String?
        var state: State = .ended
        var timeoutTimer: (any TimerScheduling)?
        /// Monotonic token identifying the current background cycle. Bumped on every
        /// state transition so a timeout callback scheduled in an earlier cycle can be
        /// recognized as stale and ignored — otherwise a timer from a previous
        /// background could fire after a foreground/background round-trip, see the state
        /// as `.backgrounded` again, and wrongly end the current session (the
        /// `AutoMobileHangs` generation-guard pattern).
        var timerGeneration = 0
    }

    private let lock = OSAllocatedUnfairLock(initialState: LockedState())
    private let timeoutMs: Int
    private let uuidProvider: @Sendable () -> String
    private let timerFactory: @Sendable () -> any TimerScheduling

    convenience init(
        timeoutMs: Int = 30000,
        uuidProvider: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
        self.init(timeoutMs: timeoutMs, uuidProvider: uuidProvider, timerFactory: { GCDTimer() })
    }

    init(
        timeoutMs: Int,
        uuidProvider: @escaping @Sendable () -> String,
        timerFactory: @escaping @Sendable () -> any TimerScheduling
    ) {
        self.timeoutMs = timeoutMs
        self.uuidProvider = uuidProvider
        self.timerFactory = timerFactory
    }

    func currentSessionId() -> String? {
        lock.withLock { $0.sessionId }
    }

    func onForeground() {
        lock.withLock { state in
            state.timeoutTimer?.cancel()
            state.timeoutTimer = nil
            // Invalidate any in-flight timeout callback from the cycle we're leaving.
            state.timerGeneration += 1
            switch state.state {
            case .ended:
                state.sessionId = uuidProvider()
                state.state = .active
            case .backgrounded:
                state.state = .active
            case .active:
                break
            }
        }
    }

    func onBackground() {
        let transition = lock.withLock { state -> (timer: any TimerScheduling, generation: Int)? in
            guard state.state == .active else { return nil }
            state.state = .backgrounded
            state.timerGeneration += 1
            let timer = timerFactory()
            state.timeoutTimer = timer
            return (timer, state.timerGeneration)
        }
        guard let (timer, generation) = transition else { return }

        timer.schedule(intervalMs: timeoutMs) { [weak self] in
            guard let self else { return }
            self.lock.withLock { state in
                // Only the timer for the current background cycle may end the session. A
                // stale timer (a foreground/background happened after it was scheduled) has
                // an older generation and is ignored, so it can't end a session that is now
                // active or belongs to a newer cycle.
                guard generation == state.timerGeneration, state.state == .backgrounded else { return }
                state.state = .ended
                state.sessionId = nil
                state.timeoutTimer?.cancel()
                state.timeoutTimer = nil
            }
        }
    }

    func shutdown() {
        lock.withLock { state in
            state.timeoutTimer?.cancel()
            state.timeoutTimer = nil
            state.timerGeneration += 1
            state.state = .ended
            state.sessionId = nil
        }
    }
}
