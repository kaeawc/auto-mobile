import Foundation

/// `voiceover_set_result` — response to `set_voiceover_state` (physical-device
/// toggle via Settings). Carries an explicit `success`/`error` rather than
/// throwing, so a locale/layout drift that leaves the VoiceOver row unlocatable
/// surfaces to the client as a typed failure, never a silent success (#2501).
/// Ported from the reference `Models.swift`; `Codable, Sendable`.
public struct VoiceOverSetResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let error: String?
    public let totalTimeMs: Int64?

    public init(requestId: String?, success: Bool, error: String? = nil, totalTimeMs: Int64?) {
        type = ResponseType.voiceOverSetResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
