import Foundation

public struct RequestSetNetworkFaultRules: Decodable, Sendable {
    public var requestId: String?
    public var rules: [NetworkFaultRuleDTO]
}

extension RequestSetNetworkFaultRules: CommandPayload {}
