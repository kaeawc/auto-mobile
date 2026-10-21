import Foundation

public struct RequestGetPreference: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
    public var key: String?
    public var fileName: String?
}

extension RequestGetPreference: CommandPayload {}
