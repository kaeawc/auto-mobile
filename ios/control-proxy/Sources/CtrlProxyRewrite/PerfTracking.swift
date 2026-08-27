import Foundation

/// The performance-tracking surface the server uses on the request path (open a
/// scope, close it, flush the accumulated tree, discard on error). A seam so the
/// server does not depend on the concrete `PerfProvider` (ported later, where its
/// per-thread call-tree is re-expressed as a task-scoped structure). A no-op or
/// fake conformer suffices for the networking phase; perf timing is diagnostic, not
/// wire-critical.
protocol PerfTracking: Sendable {
    func serial(_ name: String)
    func end()
    func flush() -> [PerfTiming]?
    func clear()

    /// Bind a fresh task-scoped call-tree for `body`, so the `serial`/`end`/`track` calls
    /// made inside it — including across `await`s into `@MainActor` collaborators in the
    /// same task — accumulate into one tree. The server brackets the command-handling entry
    /// point in this (see §9.5): without it every perf call outside a scope is a silent
    /// no-op. Async so the binding survives those awaits; declared `throws` (a protocol
    /// requirement cannot be `rethrows`, so the concrete `PerfProvider.withScope`'s
    /// `rethrows` witnesses this `throws` requirement).
    func withScope<T>(_ body: nonisolated(nonsending) () async throws -> T) async throws -> T
}
