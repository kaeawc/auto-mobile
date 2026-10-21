import Foundation

public struct RequestListTables: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
}

extension RequestListTables: CommandPayload {}
