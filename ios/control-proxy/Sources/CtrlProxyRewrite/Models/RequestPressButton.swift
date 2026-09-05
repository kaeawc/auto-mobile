import Foundation

public struct RequestPressButton: Decodable, Sendable {
    public var requestId: String?
    public var action: String
    public var frameContext: String? = nil
}

extension RequestPressButton: CommandPayload {}
