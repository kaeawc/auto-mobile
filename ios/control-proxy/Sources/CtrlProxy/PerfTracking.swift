import Foundation

/// The performance-tracking surface the server uses on the request path (open a
/// scope, close it, flush the accumulated intervals, discard on error). A seam so
/// the server does not depend on the concrete `PerfProvider`. A no-op or fake
/// conformer suffices for callers that do not need timing data.
protocol PerfTracking: Sendable {
    func serial(_ name: String)
    func end()
    func flush() -> [PerfTiming]?
    func snapshot(_ name: String) -> PerfTiming?
    func clear()

    /// Bind a fresh task-scoped interval scope for `body`, so the `serial`/`end`/`track` calls
    /// made inside it — including across `await`s into `@MainActor` collaborators in the
    /// same task — accumulate into one timing result. The server brackets the command-handling entry
    /// point in this (see §9.5): without it every perf call outside a scope is a silent
    /// no-op. Async so the binding survives those awaits; declared `throws` (a protocol
    /// requirement cannot be `rethrows`, so the concrete `PerfProvider.withScope`'s
    /// `rethrows` witnesses this `throws` requirement).
    func withScope<T>(_ body: nonisolated(nonsending)() async throws -> T) async throws -> T

    func withScope<T>(_ body: () throws -> T) throws -> T
}
