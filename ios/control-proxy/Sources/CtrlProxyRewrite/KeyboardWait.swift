import Foundation

/// Keyboard polling stays in the caller's task and yields the main actor between probes.
/// Focus, visibility, close, and destructive-key post-condition waits use an injected monotonic clock.
/// Each retains its cadence and probes after a sleep reaches or overruns the deadline.
/// Close sleeps are bounded by both the attempt and the whole-action budget.
@MainActor
enum KeyboardWait {
    struct FocusResult: Sendable {
        let hasFocus: Bool
        let strategy: String
        let iterations: Int
        let elapsedMs: Int
    }

    static func focus<C: Clock>(
        clock: C,
        timeout: Duration = .milliseconds(500),
        interval: Duration = .milliseconds(50),
        tap: () throws -> Void,
        probe: () throws -> (Bool, String)
    )
        async throws -> FocusResult where C.Duration == Duration
    {
        try Task.checkCancellation()
        let start = clock.now
        try tap()
        // The focus budget starts after the tap; elapsed logging includes the tap.
        let deadline = clock.now.advanced(by: timeout)
        var hasFocus = false
        var strategy = "none"
        var iterations = 0
        while !hasFocus, clock.now < deadline {
            try Task.checkCancellation()
            (hasFocus, strategy) = try probe()
            iterations += 1
            if !hasFocus {
                try await clock.sleep(for: interval)
                try Task.checkCancellation()
            }
        }
        if !hasFocus {
            try Task.checkCancellation()
            (hasFocus, strategy) = try probe()
            iterations += 1
        }
        let elapsed = start.duration(to: clock.now).components
        return FocusResult(
            hasFocus: hasFocus,
            strategy: strategy,
            iterations: iterations,
            elapsedMs: Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
        )
    }

    static func visibility<C: Clock>(
        clock: C,
        expected: Bool,
        timeout: Duration = .seconds(1),
        interval: Duration = .milliseconds(50),
        probe: () throws -> Bool
    )
        async throws -> Bool where C.Duration == Duration
    {
        try Task.checkCancellation()
        let deadline = clock.now.advanced(by: timeout)
        var visible = try probe()
        while visible != expected, clock.now < deadline {
            try await clock.sleep(for: interval)
            try Task.checkCancellation()
            // Probe even if the sleep reaches or passes the deadline.
            visible = try probe()
        }
        return visible
    }

    /// Next close poll, bounded by both the current attempt and the whole action.
    nonisolated static func closePollDelay<I: InstantProtocol>(
        now: I,
        attemptDeadline: I,
        closeDeadline: I
    )
        -> Duration? where I.Duration == Duration
    {
        let remaining = now.duration(to: min(attemptDeadline, closeDeadline))
        return remaining > .zero ? min(.milliseconds(100), remaining) : nil
    }

    static func close<C: Clock>(
        clock: C,
        closeDeadline: C.Instant,
        probe: () throws -> Bool
    )
        async throws -> Bool where C.Duration == Duration
    {
        try Task.checkCancellation()
        let attemptDeadline = min(clock.now.advanced(by: .milliseconds(600)), closeDeadline)
        // Visibility is checked before the budget, including after the final sleep.
        while true {
            try Task.checkCancellation()
            if try !probe() { return true }
            guard let delay = closePollDelay(
                now: clock.now, attemptDeadline: attemptDeadline, closeDeadline: closeDeadline
            ) else { return false }
            try Task.checkCancellation()
            try await clock.sleep(for: delay)
            try Task.checkCancellation()
        }
    }

    static func destructivePostCondition<C: Clock>(
        clock: C,
        probe: () throws -> Bool
    )
        async throws -> Bool where C.Duration == Duration
    {
        try Task.checkCancellation()
        let deadline = clock.now.advanced(by: .seconds(1))
        while clock.now < deadline {
            try Task.checkCancellation()
            if try probe() { return true }
            try Task.checkCancellation()
            try await clock.sleep(for: .milliseconds(50))
            try Task.checkCancellation()
        }
        // This is also the caller's final exists/value read for timeout diagnostics.
        try Task.checkCancellation()
        return try probe()
    }
}
