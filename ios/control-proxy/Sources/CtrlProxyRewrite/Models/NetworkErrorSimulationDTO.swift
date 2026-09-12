import Foundation

public struct NetworkErrorSimulationDTO: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let errorType: String?
    public let limit: Int?
    public let expiresAtEpochMs: Int64?

    public init(enabled: Bool, errorType: String?, limit: Int?, expiresAtEpochMs: Int64?) {
        self.enabled = enabled
        self.errorType = errorType
        self.limit = limit
        self.expiresAtEpochMs = expiresAtEpochMs
    }
}
