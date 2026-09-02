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

    /// Synchronous variant of `withScope`, for entry points that bind a scope around a
    /// synchronous instrumented call with no `await` to cross — the background
    /// `HierarchyDebouncer` poll runs `getViewHierarchy` synchronously on the main actor.
    /// Without a bound scope those background hierarchy timings no-op and never reach the
    /// shared pool, so the next response's pooled flush drops them (the reference pooled
    /// them; see `PerfProvider`'s "relied on and preserved" contract).
    func withScope<T>(_ body: () throws -> T) throws -> T
}
