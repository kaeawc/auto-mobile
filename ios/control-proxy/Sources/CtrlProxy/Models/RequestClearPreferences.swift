import Foundation

public struct RequestClearPreferences: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var sessionId: String?
    public var mutationToken: String?
    public var fileName: String?
}

extension RequestClearPreferences: CommandPayload {}
