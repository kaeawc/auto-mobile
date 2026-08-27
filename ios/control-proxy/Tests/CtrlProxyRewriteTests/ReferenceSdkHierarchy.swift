@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE `SdkHierarchyExtractor` into a reference `SdkHierarchyCache`
/// (imports only `CtrlProxy`). Returns module-agnostic results so a test importing neither
/// module can diff old vs new extraction.
enum ReferenceSdkHierarchy {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    /// Extract `batch` into a fresh cache; return the resulting cached hierarchy
    /// (sorted-key encoded, nil if none) and whether the update callback fired.
    static func extract(from batch: Data) -> (latestEncoded: Data?, fired: Bool) {
        let cache = SdkHierarchyCache()
        var fired = false
        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache, onHierarchyUpdated: { fired = true })
        let encoded = cache.latest.flatMap { try? sortedEncoder().encode($0) }
        return (encoded, fired)
    }
}
