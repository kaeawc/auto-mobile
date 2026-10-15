import Foundation

public struct RequestAppendText: Decodable, Sendable {
    public var requestId: String?
    public var text: String
    public var frameContext: String?
}

extension RequestAppendText: CommandPayload {}
