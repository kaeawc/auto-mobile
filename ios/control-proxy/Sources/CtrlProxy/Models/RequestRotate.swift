import Foundation

public struct RequestRotate: Decodable, Sendable {
    public var requestId: String?
    public var orientation: String
}

extension RequestRotate: CommandPayload {}
