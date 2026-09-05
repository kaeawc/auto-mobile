import Foundation

public struct RequestGetPreferences: Decodable, Sendable {
    public var requestId: String?
    public var fileName: String?
}

extension RequestGetPreferences: CommandPayload {}
