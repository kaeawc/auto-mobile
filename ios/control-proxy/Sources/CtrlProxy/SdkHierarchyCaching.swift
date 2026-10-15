import Foundation

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
