import Foundation

/// A single key-value storage entry. Ported from the reference `Models.swift`;
/// immutable value type, so `Sendable`.
public struct StorageEntry: Codable, Sendable {
    public let key: String
    public let value: String?
    public let type: String
    public let redacted: Bool?

    public init(key: String, value: String?, type: String, redacted: Bool? = nil) {
        self.key = key
        self.value = value
        self.type = type
        self.redacted = redacted
    }

    private enum CodingKeys: String, CodingKey {
        case key
        case value
        case type
        case redacted
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(key, forKey: .key)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encode(type, forKey: .type)
        if redacted == true {
            try container.encode(true, forKey: .redacted)
        }
    }
}
