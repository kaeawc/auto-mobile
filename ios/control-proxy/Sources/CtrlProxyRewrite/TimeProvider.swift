import Foundation

/// Current-time-in-milliseconds seam (injected for testability). `Sendable` so the
/// `@MainActor` FPS monitor and the perf provider can store `any TimeProvider`.
protocol TimeProvider: Sendable {
    /// Current time in milliseconds (epoch).
    func currentTimeMillis() -> Int64
}
