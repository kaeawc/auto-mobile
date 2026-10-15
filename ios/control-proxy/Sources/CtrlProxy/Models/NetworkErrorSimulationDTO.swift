import Foundation

public struct NetworkErrorSimulationDTO: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let errorType: String?
    public let limit: Int?
    public let expiresAtEpochMs: Int64?
    /// Time left, timed by the device's own monotonic clock; preferred over the host-clock epoch (#10062).
    public let remainingMs: Int64?

    public init(
        enabled: Bool, errorType: String?, limit: Int?, expiresAtEpochMs: Int64?, remainingMs: Int64? = nil
    ) {
        self.enabled = enabled
        self.errorType = errorType
        self.limit = limit
        self.expiresAtEpochMs = expiresAtEpochMs
        self.remainingMs = remainingMs
    }
}
