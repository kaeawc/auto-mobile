import Foundation

/// Information about a storage suite (a UserDefaults suite). Ported from the
/// reference `Models.swift`; immutable value type, so `Sendable`.
public struct StorageSuiteInfo: Codable, Sendable {
    public let name: String
    public let path: String
    public let displayName: String
    public let entryCount: Int

    public init(name: String, path: String? = nil, displayName: String, entryCount: Int) {
        self.name = name
        self.path = path ?? name
        self.displayName = displayName
        self.entryCount = entryCount
    }
}
