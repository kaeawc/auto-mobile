@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE `DefaultStorageInspecting`. Imports only `CtrlProxy` and
/// returns module-agnostic dictionaries so a test importing neither module can diff.
enum ReferenceStorage {
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
