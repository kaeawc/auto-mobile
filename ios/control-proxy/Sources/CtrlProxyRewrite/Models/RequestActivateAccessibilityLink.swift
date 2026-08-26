import Foundation

public struct RequestActivateAccessibilityLink: Decodable, Sendable {
    public var requestId: String?
    public var text: String
    public var occurrence: Int
    public var ownerResourceId: String?
}

extension RequestActivateAccessibilityLink: CommandPayload {}
