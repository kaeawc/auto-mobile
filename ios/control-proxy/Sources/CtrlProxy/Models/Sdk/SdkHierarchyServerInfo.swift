import AutoMobileSdkWire
import Foundation

public struct SdkHierarchyServerInfo: Codable, Sendable {
    public let status: String
    public let bundleId: String?
    public let capabilities: Set<String>
    public let simulatorUdid: String?
    /// Absent when the app's SDK predates observation-bridge discovery (#5159).
    public let observationBridge: ObservationBridgeState?

    public init(
        status: String,
        bundleId: String?,
        capabilities: Set<String> = [],
        simulatorUdid: String? = nil,
        observationBridge: ObservationBridgeState? = nil
    ) {
        self.status = status
        self.bundleId = bundleId
        self.capabilities = capabilities
        self.simulatorUdid = simulatorUdid
        self.observationBridge = observationBridge
    }

    private enum CodingKeys: String, CodingKey {
        case status, bundleId, capabilities, simulatorUdid, observationBridge
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(String.self, forKey: .status)
        bundleId = try values.decodeIfPresent(String.self, forKey: .bundleId)
        capabilities = try values.decodeIfPresent(Set<String>.self, forKey: .capabilities) ?? []
        simulatorUdid = try values.decodeIfPresent(String.self, forKey: .simulatorUdid)
        // A malformed bridge object degrades to "absent" rather than hiding the whole SDK.
        observationBridge = try? values.decodeIfPresent(ObservationBridgeState.self, forKey: .observationBridge)
    }
}
