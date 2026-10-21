import Foundation

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
