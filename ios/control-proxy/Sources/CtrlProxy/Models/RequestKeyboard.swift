import Foundation

public struct RequestKeyboard: Decodable, Sendable {
    public var requestId: String?
    public var action: String
}

extension RequestKeyboard: CommandPayload {}
