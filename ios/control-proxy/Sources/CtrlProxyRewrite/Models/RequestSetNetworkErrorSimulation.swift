import Foundation

public struct RequestSetNetworkErrorSimulation: Decodable, Sendable {
    public var requestId: String?
    public var enabled: Bool
    public var errorType: String?
    public var limit: Int?
    public var expiresAtEpochMs: Int64?
}

extension RequestSetNetworkErrorSimulation: CommandPayload {}
