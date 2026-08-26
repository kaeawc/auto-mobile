import Foundation

public struct RequestImeAction: Decodable, Sendable {
    public var requestId: String?
    public var action: String
}

extension RequestImeAction: CommandPayload {}
