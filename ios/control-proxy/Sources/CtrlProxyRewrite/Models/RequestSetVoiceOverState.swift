import Foundation

/// Request to enable/disable VoiceOver by driving the Settings app (physical
/// devices have no `simctl` toggle; the host handles the Simulator). See #2501.
public struct RequestSetVoiceOverState: Decodable, Sendable {
    public var requestId: String?
    public var enabled: Bool
}

extension RequestSetVoiceOverState: CommandPayload {}
