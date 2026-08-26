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
}
