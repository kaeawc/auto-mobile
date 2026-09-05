import Foundation

/// `voiceover_state_result` — response to `get_voiceover_state`. Ported from the
/// reference `Models.swift`; `Codable, Sendable`.
public struct VoiceOverStateResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let enabled: Bool
    public let totalTimeMs: Int64?

    public init(requestId: String?, enabled: Bool, totalTimeMs: Int64?) {
        type = ResponseType.voiceOverStateResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        success = true
        self.enabled = enabled
        self.totalTimeMs = totalTimeMs
    }
}
