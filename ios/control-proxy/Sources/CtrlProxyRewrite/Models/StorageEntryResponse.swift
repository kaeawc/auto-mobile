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

    public init(
        requestId: String?,
        success: Bool,
        found: Bool,
        key: String? = nil,
        value: String? = nil,
        valueType: String? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
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
    }
}
