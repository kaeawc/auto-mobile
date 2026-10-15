import Foundation

public struct PerformanceUpdateResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let performanceData: PerformanceSnapshot

    public init(data: PerformanceSnapshot) {
        type = "performance_update"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        performanceData = data
    }
}
