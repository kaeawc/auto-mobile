import Foundation

public struct RequestAccessibilityFocus: Codable, Sendable {
    public var requestId: String?
    public var resourceId: String?
    public var text: String?
    public var contentDesc: String?
}

extension RequestAccessibilityFocus: CommandPayload {}

public enum AccessibilityFocusErrorCode: String, Codable, Sendable {
    case voiceOverOff = "voiceover_off"
    case sdkUnavailable = "sdk_unavailable"
    case elementNotFound = "element_not_found"
    case invalidSelector = "invalid_selector"
    case unsupported
}

public struct SdkAccessibilityFocusReply: Decodable, Sendable {
    public let status: String
    public let errorCode: AccessibilityFocusErrorCode?
}

public struct AccessibilityFocusResponse: Encodable, Sendable {
    public let type = ResponseType.accessibilityFocusResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requestId: String?
    public let success: Bool
    public let errorCode: AccessibilityFocusErrorCode?
    public let error: String?
    public let totalTimeMs: Int64
}
