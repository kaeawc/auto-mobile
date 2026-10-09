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
