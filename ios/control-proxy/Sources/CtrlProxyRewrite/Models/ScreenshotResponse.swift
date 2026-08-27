import Foundation

/// `screenshot` response envelope. Ported from the reference `Models.swift`;
/// `Codable, Sendable` value type. Encoded straight through by
/// `WebSocketServer.encodeResponse` (no `perfTiming` injection), matching the
/// reference's dedicated `ScreenshotResponse` encode branch.
public struct ScreenshotResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let format: String
    public let data: String // Base64 encoded
    public let frameContext: String?

    /// Display rotation at screenshot capture: Android-compatible 0..3, nil when unavailable.
    public let rotation: Int?

    public init(
        requestId: String?,
        data: String,
        format: String = "png",
        rotation: Int? = nil,
        frameContext: String? = nil
    ) {
        type = "screenshot"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.format = format
        self.data = data
        self.frameContext = frameContext
        self.rotation = rotation
    }
}
