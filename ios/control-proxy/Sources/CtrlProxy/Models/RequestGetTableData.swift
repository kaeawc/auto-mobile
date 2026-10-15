import Foundation

public struct RequestGetTableData: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var table: String?
    public var limit: Int?
    public var offset: Double?
}

extension RequestGetTableData: CommandPayload {}
