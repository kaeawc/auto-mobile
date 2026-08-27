import Foundation

/// Narrow seam the `CommandHandler` uses to retune the hierarchy poll cadence for
/// `set_hierarchy_poll_interval`. The reference exposed the whole debouncer; this
/// narrows the dependency to the single method the router actually calls (YAGNI — the
/// coordinator wires the concrete `HierarchyDebouncer`'s start/stop/callbacks directly,
/// so those never need to cross this seam).
///
/// `@MainActor` because `HierarchyDebouncer` is an `@MainActor` state machine; `Sendable`
/// so the `Sendable` `CommandHandler` can hold `(any HierarchyDebouncing)?`.
@MainActor
public protocol HierarchyDebouncing: Sendable {
    /// Update the polling interval used for future hierarchy checks. Resets the idle
    /// backoff to the new base and, if running, reschedules the pending poll.
    func updatePollIntervalMs(_ pollIntervalMs: Int64)
}
