@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite` `DefaultStorageInspecting` (see `ReferenceStorage`).
enum RewriteStorage {
    private static func normalize(_ entry: StorageEntry) -> [String: String] {
        ["key": entry.key, "value": entry.value ?? "<nil>", "type": entry.type]
    }

    static func entry(suite: String?, key: String) -> [String: String]? {
        DefaultStorageInspecting().getEntry(suiteName: suite, key: key).map(normalize)
    }

    static func entries(suite: String?) -> [[String: String]] {
        DefaultStorageInspecting().getEntries(suiteName: suite).map(normalize)
    }

    static func suiteNames() -> [String] {
        DefaultStorageInspecting().listSuites().map(\.name)
    }
}
