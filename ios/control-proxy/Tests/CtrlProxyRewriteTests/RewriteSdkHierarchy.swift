@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite` `SdkHierarchyExtractor` into a rewrite
/// `SdkHierarchyCache` (see `ReferenceSdkHierarchy`).
enum RewriteSdkHierarchy {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    static func extract(from batch: Data) -> (latestEncoded: Data?, fired: Bool) {
        let cache = SdkHierarchyCache()
        var fired = false
        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache, onHierarchyUpdated: { fired = true })
        let encoded = cache.latest.flatMap { try? sortedEncoder().encode($0) }
        return (encoded, fired)
    }
}
