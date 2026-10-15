import Foundation

/// App-state polling stays in the caller's task and yields the main actor between probes.
@MainActor
enum AppStateWait {
    /// Preserve the lifecycle expectations for `XCUIApplication.State.rawValue`.
    nonisolated static func matches(rawState: UInt, expected: AppStateExpectation) -> Bool {
        switch expected {
        case .foreground: rawState >= 4
        case .notRunning: rawState <= 1
        case .background: rawState == 3
        }
    }

    /// Sleep only between failed probes; exhaustion or cancellation returns `false`.
    static func poll(
        clock: any Clock<Duration>,
        attempts: Int = 10,
        interval: Duration = .milliseconds(50),
        probe: () -> Bool
    )
        async -> Bool
    {
        guard attempts > 0 else { return false }
        for attempt in 0 ..< attempts {
            guard !Task.isCancelled else { return false }
            if probe() { return true }
            if attempt < attempts - 1 {
                do {
                    try await clock.sleep(for: interval)
                } catch {
                    return false
                }
            }
        }
        return false
    }
}
