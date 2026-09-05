import Foundation

/// Payload for commands that carry no parameters beyond the request id.
public struct RequestEnvelope: Decodable, Sendable {
    public var requestId: String?
    public var frameContext: String? = nil
}

extension RequestEnvelope: CommandPayload {}
