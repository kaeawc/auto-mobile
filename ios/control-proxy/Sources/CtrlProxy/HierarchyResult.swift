import Foundation

enum HierarchyResult: Sendable {
    /// New hierarchy extracted with different structural content.
    case changed(hierarchy: ViewHierarchy, hash: Int, extractionTimeMs: Int64)

    /// Hierarchy extracted but structure unchanged (animation only).
    case unchanged(hierarchy: ViewHierarchy, hash: Int, extractionTimeMs: Int64, skippedPollCount: Int)

    /// Failed to extract hierarchy.
    case error(message: String)
}
