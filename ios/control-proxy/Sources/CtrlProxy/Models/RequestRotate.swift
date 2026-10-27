import Foundation

public struct RequestRotate: Decodable, Sendable {
    public var requestId: String?
    public var orientation: String
}

extension RequestRotate: CommandPayload {}

/// Read the system light/dark appearance, or set it first when `appearance` is
/// "light" or "dark" (#14092). The result always carries the appearance read back.
public struct RequestAppearance: Decodable, Sendable {
    public var requestId: String?
    public var appearance: String?
}

extension RequestAppearance: CommandPayload {}

/// Activate Siri with `text` as if it were recognized speech (#14109), for example an App
/// Shortcut phrase. The runner replies once Siri accepted the text, not when the intent ran.
public struct RequestSiri: Decodable, Sendable {
    public var requestId: String?
    public var text: String
}

extension RequestSiri: CommandPayload {}
