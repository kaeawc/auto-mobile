import Foundation

/// `get_preference_result` — response to `get_preference`. Ported from the
/// reference `Models.swift`; `Codable, Sendable`.
public struct StorageEntryResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let found: Bool
    public let key: String?
    public let value: String?
    public let valueType: String?
    public let error: String?
    public let totalTimeMs: Int64?
    public let redacted: Bool?

    public init(
        requestId: String?,
        success: Bool,
        found: Bool,
        key: String? = nil,
        value: String? = nil,
        valueType: String? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil,
        redacted: Bool? = nil
    ) {
        type = ResponseType.getPreferenceResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.found = found
        self.key = key
        self.value = value
        self.valueType = valueType
        self.error = error
        self.totalTimeMs = totalTimeMs
        self.redacted = redacted
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case timestamp
        case requestId
        case success
        case found
        case key
        case value
        case valueType
        case error
        case totalTimeMs
        case redacted
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encodeIfPresent(requestId, forKey: .requestId)
        try container.encode(success, forKey: .success)
        try container.encode(found, forKey: .found)
        try container.encodeIfPresent(key, forKey: .key)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encodeIfPresent(valueType, forKey: .valueType)
        try container.encodeIfPresent(error, forKey: .error)
        try container.encodeIfPresent(totalTimeMs, forKey: .totalTimeMs)
        if redacted == true {
            try container.encode(true, forKey: .redacted)
        }
    }
}
