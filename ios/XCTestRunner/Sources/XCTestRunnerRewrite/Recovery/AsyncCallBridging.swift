import Foundation

/// Bridges a single async call to the synchronous XCTest executor thread with a **bound**. The
/// recovery loop drives the model call synchronously (matching how the executor already drives
/// `AutoMobileMCPClient`), but a hung model call must fail the recovery attempt rather than wedge
/// the runner forever (issue #5644). A seam so the handler's timeout handling is unit-testable with
/// a fake, and the production bound is testable directly with a tiny timeout.
///
/// Refines `Sendable` so the Sendable handler can hold it. Under strict concurrency the operation is
/// `@escaping @Sendable` and `T` is `Sendable` (it flows through a `Task` — proven by the Phase-0.5
/// spike; `ModelResponse` satisfies it).
protocol AsyncCallBridging: Sendable {
    /// Runs `operation` and blocks the caller until it completes or `timeout` seconds elapse.
    /// Throws `RecoveryTimeoutError` on timeout; rethrows any error `operation` throws.
    func run<T: Sendable>(timeout: TimeInterval, _ operation: @escaping @Sendable () async throws -> T) throws -> T
}
