import Foundation

/// Production `TimeProvider` over the system clock. Stateless → genuinely `Sendable`.
struct SystemTimeProvider: TimeProvider {
    func currentTimeMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
