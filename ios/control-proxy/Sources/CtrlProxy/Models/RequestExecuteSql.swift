import Foundation

public struct RequestExecuteSql: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var query: String?
    public var sessionId: String?
    public var mutationToken: String?
    /// Set by the host when it classified the query as a read; the SDK refuses any write (#10966).
    public var readOnly: Bool?
}

extension RequestExecuteSql: CommandPayload {}

/// Read-only entity fetch; no SQL or mutation credentials are accepted by this command.
public struct RequestQueryCoreData: Codable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var store: String
    public var entity: String
    public var limit: Int?
}

extension RequestQueryCoreData: CommandPayload {}
