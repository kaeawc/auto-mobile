import Foundation

/// Keyboard polling stays in the caller's task and yields the main actor between probes.
/// The two cadences intentionally preserve their different deadline-edge behavior.
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
            // Unlike focus, visibility probes even if the sleep reaches the deadline.
            visible = try probe()
        }
        return visible
    }
}
