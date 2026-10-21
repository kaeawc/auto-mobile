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
