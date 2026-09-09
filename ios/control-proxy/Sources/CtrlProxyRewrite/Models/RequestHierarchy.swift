import Foundation

public struct RequestHierarchy: Decodable, Sendable {
    public var requestId: String?
    public var disableAllFiltering: Bool?
    public var sinceTimestamp: Int64?
}

extension RequestHierarchy: CommandPayload {}
