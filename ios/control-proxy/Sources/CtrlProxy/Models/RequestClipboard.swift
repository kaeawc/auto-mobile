import Foundation

public struct RequestClipboard: Decodable, Sendable {
    public var requestId: String?
    public var action: String
    public var text: String?
}

extension RequestClipboard: CommandPayload {}
