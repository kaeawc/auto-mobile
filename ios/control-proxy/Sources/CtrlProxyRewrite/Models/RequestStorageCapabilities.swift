import Foundation

public struct RequestStorageCapabilities: Decodable, Sendable {
    public var requestId: String?
    public var appId: String?
}

extension RequestStorageCapabilities: CommandPayload {}
