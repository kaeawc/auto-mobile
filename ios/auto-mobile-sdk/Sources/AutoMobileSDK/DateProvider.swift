import Foundation

/// Abstraction over date/time for deterministic testing.
protocol DateProvider: Sendable {
    /// Returns the current date.
    func now() -> Date
}

/// Default DateProvider that returns the real system time.
struct SystemDateProvider: DateProvider, Sendable {
    init() {}
    func now() -> Date { Date() }
}
