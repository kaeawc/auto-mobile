import Foundation

public struct RequestListDatabases: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
}

extension RequestListDatabases: CommandPayload {}
