import Foundation

public struct RequestExecuteSql: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var query: String?
    public var sessionId: String?
}

extension RequestExecuteSql: CommandPayload {}
