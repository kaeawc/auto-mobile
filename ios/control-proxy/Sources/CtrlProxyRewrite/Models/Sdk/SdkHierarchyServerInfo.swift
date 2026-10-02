import Foundation

/// Lightweight metadata exposed by the in-app SDK hierarchy server's `/health`
/// endpoint. Ported from the reference `SdkHierarchyModels.swift`; already an
/// immutable value type, so `Sendable`.
public struct SdkHierarchyServerInfo: Codable, Sendable {
    public let status: String
    public let bundleId: String?
    public let capabilities: Set<String>
    public let simulatorUdid: String?

    public init(status: String, bundleId: String?, capabilities: Set<String> = [], simulatorUdid: String? = nil) {
        self.status = status
        self.bundleId = bundleId
        self.capabilities = capabilities
        self.simulatorUdid = simulatorUdid
    }

    private enum CodingKeys: String, CodingKey {
        case status, bundleId, capabilities, simulatorUdid
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(String.self, forKey: .status)
        bundleId = try values.decodeIfPresent(String.self, forKey: .bundleId)
        capabilities = try values.decodeIfPresent(Set<String>.self, forKey: .capabilities) ?? []
        simulatorUdid = try values.decodeIfPresent(String.self, forKey: .simulatorUdid)
    }
}
