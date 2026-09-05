import Foundation

public struct RequestClearText: Decodable, Sendable {
    public var requestId: String?
    public var resourceId: String?
}

extension RequestClearText: CommandPayload {}
