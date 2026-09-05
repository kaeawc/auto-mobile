import Foundation

/// `keyboard_result` response envelope with the keyboard's visibility state after
/// the command. Ported from the reference `Models.swift`; `Codable, Sendable`.
public struct KeyboardResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let open: Bool
    public let totalTimeMs: Int64
    public let error: String?

    public init(
        requestId: String?,
        success: Bool,
        open: Bool,
        totalTimeMs: Int64,
        error: String? = nil
    ) {
        type = ResponseType.keyboardResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.open = open
        self.totalTimeMs = totalTimeMs
        self.error = error
    }
}
