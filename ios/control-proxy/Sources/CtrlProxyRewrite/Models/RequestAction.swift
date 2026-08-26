import Foundation

public struct RequestAction: Decodable, Sendable {
    public var requestId: String?
    public var action: String
    public var resourceId: String?
    public var label: String?
}

extension RequestAction: CommandPayload {}
