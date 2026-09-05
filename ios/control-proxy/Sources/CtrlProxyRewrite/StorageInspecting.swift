import Foundation

/// Protocol for inspecting key-value storage (UserDefaults on iOS). Ported from the
/// reference `Protocols.swift`.
///
/// Refines `Sendable`: the CommandHandler (a `Sendable` POD router in Phase 6) holds
/// an optional `StorageInspecting`, so the existential must itself be `Sendable`.
/// UserDefaults is thread-safe, so conformers need no isolation.
public protocol StorageInspecting: Sendable {
    /// List available storage suites.
    func listSuites() -> [StorageSuiteInfo]

    /// Get all entries from a suite.
    func getEntries(suiteName: String?) -> [StorageEntry]

    /// Get a single entry by key.
    func getEntry(suiteName: String?, key: String) -> StorageEntry?

    /// Set an entry value.
    func setEntry(suiteName: String?, key: String, value: String?, type: String) throws

    /// Remove an entry by key.
    func removeEntry(suiteName: String?, key: String) throws

    /// Clear all entries in a suite.
    func clearEntries(suiteName: String?) throws
}
