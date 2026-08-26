import Foundation

public struct RequestSetNetworkMockRules: Decodable, Sendable {
    public var requestId: String?
    public var rules: [NetworkMockRuleDTO]
}

extension RequestSetNetworkMockRules: CommandPayload {}
