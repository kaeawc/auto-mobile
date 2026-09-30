import Foundation

public struct HingeAngleResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let error: String?
    public let angle: Double?
    public let totalTimeMs: Int64

    public init(
        requestId: String?,
        success: Bool,
        error: String? = nil,
        angle: Double? = nil,
        totalTimeMs: Int64
    ) {
        type = ResponseType.hingeAngleResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.error = error
        self.angle = angle
        self.totalTimeMs = totalTimeMs
    }
}
