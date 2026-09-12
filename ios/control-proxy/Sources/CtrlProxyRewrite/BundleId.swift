import Foundation

/// Canonical bundle-identifier normalization, shared across the SDK-hierarchy cache and
/// (in Phase 6) the CommandHandler. Ported from the reference `CommandHandler`'s private
/// `normalizedBundleId` so there is one implementation of the rule rather than a copy per
/// call site.
enum BundleId {
    /// Trim surrounding whitespace/newlines; return nil for a nil-or-empty result, so a
    /// blank bundle id is treated as "unknown" rather than matching another blank.
    static func normalized(_ bundleId: String?) -> String? {
        guard let trimmed = bundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else {
            return nil
        }
        return trimmed
    }
}
