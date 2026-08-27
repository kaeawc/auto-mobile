import Foundation

/// Monotonic-millisecond clock + scheduling seam (injected for testability).
///
/// Renamed from the reference's `Timer` protocol, which shadowed `Foundation.Timer`
/// (the reference never used the Foundation type, but the name was a hazard — see the
/// README fixup index; the rename is pulled forward from Phase 5 because the
/// `@MainActor` `HierarchyDebouncer` needs this seam in Phase 4). Behavior is unchanged.
///
/// `Sendable` so the scheduled `@Sendable` callback can escape to another queue and so
/// the coordinator / samplers can store `any ProxyTimer` across isolation domains.
protocol ProxyTimer: Sendable {
    /// Current time in milliseconds.
    func now() -> Int64

    /// Wait for the specified number of milliseconds.
    func wait(milliseconds: Int64) async

    /// Schedule a callback to run after the specified number of milliseconds.
    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void)
}
