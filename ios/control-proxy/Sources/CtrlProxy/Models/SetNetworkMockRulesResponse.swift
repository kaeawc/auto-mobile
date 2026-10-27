import Foundation

public struct SetNetworkMockRulesResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let totalTimeMs: Int64?
    /// Ids of the rules the app's regex engine rejected (issue #10101). Nil when the SDK did not report
    /// (an older SDK), which the host reads as "sent, not confirmed"; an empty list means all were installed.
    public let rejectedMockIds: [String]?
    /// The SDK's reason for each id in `rejectedMockIds`.
    public let rejectedReasons: [String: String]?

    public init(
        requestId: String?,
        ok success: Bool,
        totalTimeMs: Int64?,
        rejectedMockIds: [String]? = nil,
        rejectedReasons: [String: String]? = nil
    ) {
        type = ResponseType.setNetworkMockRulesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
        self.rejectedMockIds = rejectedMockIds
        self.rejectedReasons = rejectedReasons
    }

    private enum CodingKeys: String, CodingKey {
        case type, timestamp, requestId, totalTimeMs, rejectedMockIds, rejectedReasons
        case success = "ok"
    }
}
