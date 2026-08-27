import Foundation

/// `current_focus_result` — the element holding the VoiceOver cursor. Mirrors
/// Android's `CurrentFocusResult` so the TS client can share a shape (#3924).
/// Ported from the reference `Models.swift`; `Codable, Sendable`. Note: this
/// envelope carries no `timestamp` field (parity with the reference).
public struct CurrentFocusResponse: Codable, Sendable {
    public let type: String
    public let requestId: String?
    public let success: Bool
    public let focusedElement: UIElementInfo?
    public let totalTimeMs: Int64
    public let error: String?

    public init(
        requestId: String? = nil,
        focusedElement: UIElementInfo? = nil,
        totalTimeMs: Int64,
        error: String? = nil
    ) {
        type = ResponseType.currentFocusResult.rawValue
        self.requestId = requestId
        success = error == nil
        self.focusedElement = focusedElement
        self.totalTimeMs = totalTimeMs
        self.error = error
    }
}
