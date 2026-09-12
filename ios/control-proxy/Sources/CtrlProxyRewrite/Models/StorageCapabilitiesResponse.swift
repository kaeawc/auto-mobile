import Foundation

/// `storage_capabilities_result` envelope. Ported from the reference `Models.swift`;
/// `Codable, Sendable` value type. (Joins `WebSocketResponsePayload` in the
/// CommandHandler phase.)
public struct StorageCapabilitiesResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let capabilities: SdkStorageCapabilities?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        capabilities: SdkStorageCapabilities? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.storageCapabilitiesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.capabilities = capabilities
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
