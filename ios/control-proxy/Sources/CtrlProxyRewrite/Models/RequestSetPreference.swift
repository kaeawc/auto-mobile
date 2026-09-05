import Foundation

public struct RequestSetPreference: Decodable, Sendable {
    public var requestId: String?
    public var key: String
    public var value: String?
    public var valueType: String
    public var fileName: String?
}

extension RequestSetPreference: CommandPayload {}
