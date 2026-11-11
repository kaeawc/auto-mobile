import Foundation

public struct RequestPressButton: Decodable, Sendable {
    public var requestId: String?
    public var action: String
    public var durationMs: Int?
    public var frameContext: String?
}

extension RequestPressButton: CommandPayload {}
