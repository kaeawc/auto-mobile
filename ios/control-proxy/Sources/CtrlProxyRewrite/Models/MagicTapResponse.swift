import Foundation

/// Direct in-app responder invocation; this does not synthesize a VoiceOver gesture.
public struct MagicTapResponse: Encodable, Sendable {
    public let type = ResponseType.magicTapResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requiresVoiceOver = false
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let handled: Bool?
    public let unsupported: Bool
    public let error: String?
    public let totalTimeMs: Int64

    init(requestId: String?, available: Bool, handled: Bool?, error: String?, totalTimeMs: Int64) {
        self.requestId = requestId
        self.available = available
        self.handled = handled
        success = handled == true
        unsupported = !available || handled == false
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
