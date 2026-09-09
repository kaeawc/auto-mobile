import Foundation

/// `rotate_result` response envelope with orientation details. Ported from the
/// reference `Models.swift`; `Codable, Sendable`.
public struct RotateResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let totalTimeMs: Int64
    public let previousOrientation: String
    public let currentOrientation: String
    public let value: Int
    public let rotationPerformed: Bool
    public let error: String?

    public init(
        requestId: String?,
        success: Bool,
        totalTimeMs: Int64,
        previousOrientation: String,
        currentOrientation: String,
        value: Int,
        rotationPerformed: Bool,
        error: String? = nil
    ) {
        type = ResponseType.rotateResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
        self.previousOrientation = previousOrientation
        self.currentOrientation = currentOrientation
        self.value = value
        self.rotationPerformed = rotationPerformed
        self.error = error
    }
}
