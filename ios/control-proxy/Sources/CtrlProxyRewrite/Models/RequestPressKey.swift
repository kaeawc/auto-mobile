import Foundation

public struct RequestPressKey: Decodable, Sendable {
    public var requestId: String?
    public var key: String
    public var modifiers: [String]
}

extension RequestPressKey: CommandPayload {}
