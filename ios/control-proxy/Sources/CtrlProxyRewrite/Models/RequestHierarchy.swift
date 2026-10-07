import Foundation

public struct RequestHierarchy: Decodable, Sendable {
    public var requestId: String?
    public var disableAllFiltering: Bool?
}

extension RequestHierarchy: CommandPayload {}
