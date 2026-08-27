import Foundation

/// `preferences` — response to `get_preferences`. Ported from the reference
/// `Models.swift`; `Codable, Sendable`.
public struct StorageEntriesResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let entries: [StorageEntry]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        entries: [StorageEntry]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.preferences.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.entries = entries
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
