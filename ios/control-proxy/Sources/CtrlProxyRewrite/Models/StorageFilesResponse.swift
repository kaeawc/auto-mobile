import Foundation

/// `preference_files` — response to `list_preference_files`. Ported from the
/// reference `Models.swift`; `Codable, Sendable`.
public struct StorageFilesResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let files: [StorageSuiteInfo]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        files: [StorageSuiteInfo]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.preferenceFiles.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.files = files
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
