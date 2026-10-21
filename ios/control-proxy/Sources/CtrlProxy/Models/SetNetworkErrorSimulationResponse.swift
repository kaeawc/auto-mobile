import Foundation

public struct SetNetworkErrorSimulationResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let totalTimeMs: Int64?

    public init(requestId: String?, ok success: Bool, totalTimeMs: Int64?) {
        type = ResponseType.setNetworkErrorSimulationResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
    }

    private enum CodingKeys: String, CodingKey {
        case type, timestamp, requestId, totalTimeMs
        case success = "ok"
    }
}
