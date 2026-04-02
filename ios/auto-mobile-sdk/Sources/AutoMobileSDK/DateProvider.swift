import Foundation

/// Abstraction over date/time for deterministic testing.
public protocol DateProvider: Sendable {
    /// Returns the current date.
    func now() -> Date
}

/// Default DateProvider that returns the real system time.
public struct SystemDateProvider: DateProvider, Sendable {
    public init() {}
    public func now() -> Date { Date() }
}
