import Foundation

public struct RequestGetTableStructure: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var table: String?
}

extension RequestGetTableStructure: CommandPayload {}
