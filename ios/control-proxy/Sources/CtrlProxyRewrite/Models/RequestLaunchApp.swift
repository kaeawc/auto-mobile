import Foundation

public struct RequestLaunchApp: Decodable, Sendable {
    public var requestId: String?
    public var bundleId: String
    public var coldBoot: Bool?
}

extension RequestLaunchApp: CommandPayload {}
