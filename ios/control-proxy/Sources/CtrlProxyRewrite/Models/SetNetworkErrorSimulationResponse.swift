import Foundation

/// `set_network_error_simulation_result` response envelope. Ported from the
/// reference `Models.swift`; `Codable, Sendable`.
public struct SetNetworkErrorSimulationResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let ok: Bool
    public let totalTimeMs: Int64?

    public init(requestId: String?, ok: Bool, totalTimeMs: Int64?) {
        type = ResponseType.setNetworkErrorSimulationResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.ok = ok
        self.totalTimeMs = totalTimeMs
    }
}
