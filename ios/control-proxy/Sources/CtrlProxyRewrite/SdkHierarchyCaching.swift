import Foundation

/// Protocol for accessing the cached SDK hierarchy. Ported from the reference
/// `Protocols.swift`, with one addition: the transactional `reconcile(matchingBundleId:)`
/// that closes race #2 (see `SdkHierarchyCache`).
///
/// Refines `Sendable`: the cache is written on the network queue (via
/// `SdkHierarchyExtractor` from `POST /sdk-events`) and read on the command path, and a
/// Phase-6 `Sendable` CommandHandler holds it. Every method is synchronous — the concrete
/// cache is lock-confined, so callers never `await`.
public protocol SdkHierarchyCaching: Sendable {
    /// The latest cached SDK view hierarchy, or nil if none received yet.
    var latest: SdkViewHierarchy? { get }
    /// Update the cached hierarchy.
    func update(_ hierarchy: SdkViewHierarchy)
    /// Clear the cached hierarchy.
    func clear()
    /// Transactionally reconcile the cache against the current foreground app: if a
    /// hierarchy is cached and its normalized bundle id equals `foregroundBundleId`,
    /// return it; otherwise clear the cache and return nil. Read → compare → clear happen
    /// as one atomic step (see `SdkHierarchyCache` for why this closes race #2).
    func reconcile(matchingBundleId foregroundBundleId: String) -> SdkViewHierarchy?
}
