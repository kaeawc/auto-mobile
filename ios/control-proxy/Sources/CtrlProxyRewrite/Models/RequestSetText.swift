import Foundation

public struct RequestSetText: Decodable, Sendable {
    public var requestId: String?
    public var text: String
    public var resourceId: String?
    public var frameContext: String?
}

extension RequestSetText: CommandPayload {}
