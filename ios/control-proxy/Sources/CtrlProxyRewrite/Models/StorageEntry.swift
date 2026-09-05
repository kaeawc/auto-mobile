import Foundation

/// A single key-value storage entry. Ported from the reference `Models.swift`;
/// immutable value type, so `Sendable`.
public struct StorageEntry: Codable, Sendable {
    public let key: String
    public let value: String?
    public let type: String

    public init(key: String, value: String?, type: String) {
        self.key = key
        self.value = value
        self.type = type
    }
}
