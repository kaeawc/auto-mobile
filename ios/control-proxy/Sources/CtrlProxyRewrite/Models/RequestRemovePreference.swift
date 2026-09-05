import Foundation

public struct RequestRemovePreference: Decodable, Sendable {
    public var requestId: String?
    public var key: String
    public var fileName: String?
}

extension RequestRemovePreference: CommandPayload {}
