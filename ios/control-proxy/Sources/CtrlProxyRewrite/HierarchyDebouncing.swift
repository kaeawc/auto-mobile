import Foundation

/// Narrow seam the `CommandHandler` uses to retune polling and record filtered captures.
/// The coordinator wires the concrete debouncer's start/stop/callbacks directly, so
/// those never need to cross this seam.
///
/// `@MainActor` because `HierarchyDebouncer` is an `@MainActor` state machine; `Sendable`
/// so the `Sendable` `CommandHandler` can hold `(any HierarchyDebouncing)?`.
@MainActor
public protocol HierarchyDebouncing: Sendable {
    /// Update the polling interval used for future hierarchy checks. Resets the idle
    /// backoff to the new base and, if running, reschedules the pending poll.
    func updatePollIntervalMs(_ pollIntervalMs: Int64)

    /// Reserve an ordering token immediately before extraction, on the same actor turn.
    /// Shared by polls and commands; independent of the hierarchy's wire timestamp.
    func beginCapture() -> UInt64

    /// Remember a raw, filtered XCUITest capture without changing poll detection or cadence.
    /// A capture that began earlier must not replace one that began later.
    func recordCommandCapture(_ hierarchy: ViewHierarchy, captureSequence: UInt64)
}
