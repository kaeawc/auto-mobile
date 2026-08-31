import Foundation

/// Production timer over the wall clock. A stateless value type (was a needless `final class` in the
/// reference), so it is `Sendable` with no lock or `@unchecked`.
public struct SystemTimer: AutoMobileTimer {
    public init() {}

    public func now() -> TimeInterval {
        return Date().timeIntervalSince1970
    }

    public func sleep(seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }
}
