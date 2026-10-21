import Foundation

public struct RequestSetHierarchyPollInterval: Decodable, Sendable {
    public var requestId: String?
    public var intervalMs: Int64
}

extension RequestSetHierarchyPollInterval: CommandPayload {}
