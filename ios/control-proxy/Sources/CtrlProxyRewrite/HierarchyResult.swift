import Foundation

/// Result of a hierarchy extraction + structural-hash comparison, delivered to the
/// debouncer's `onResult` callback. Ported from the reference `HierarchyResult`.
///
/// In practice the debouncer only ever emits `.changed` (both the initial broadcast and
/// every debounced content change). `.unchanged` / `.error` are retained because the
/// consumer (`CtrlProxy`'s `onResult` handler) switches exhaustively over all three —
/// the type models the three extraction outcomes even though the current debouncer path
/// swallows the other two rather than emitting them.
///
/// `Sendable` (its associated `ViewHierarchy` is `Sendable`) so it can ride the
/// `@MainActor` callback out to the transport layer without an isolation warning.
enum HierarchyResult: Sendable {
    /// New hierarchy extracted with different structural content.
    case changed(hierarchy: ViewHierarchy, hash: Int, extractionTimeMs: Int64)

    /// Hierarchy extracted but structure unchanged (animation only).
    case unchanged(hierarchy: ViewHierarchy, hash: Int, extractionTimeMs: Int64, skippedPollCount: Int)

    /// Failed to extract hierarchy.
    case error(message: String)
}
