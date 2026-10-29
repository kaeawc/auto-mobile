import AutoMobileSdkWire
import Foundation

public struct SdkHierarchyServerInfo: Codable, Sendable {
    public let status: String
    public let bundleId: String?
    public let capabilities: Set<String>
    public let simulatorUdid: String?
    /// Absent when the app's SDK predates observation-bridge discovery (#5159).
    public let observationBridge: ObservationBridgeState?
    /// Absent when the app's SDK predates web-view discovery (#5162).
    public let webViewBridge: WebViewBridgeState?

    public init(
        status: String,
        bundleId: String?,
        capabilities: Set<String> = [],
        simulatorUdid: String? = nil,
        observationBridge: ObservationBridgeState? = nil,
        webViewBridge: WebViewBridgeState? = nil
    ) {
        self.status = status
        self.bundleId = bundleId
        self.capabilities = capabilities
        self.simulatorUdid = simulatorUdid
        self.observationBridge = observationBridge
        self.webViewBridge = webViewBridge
    }

    private enum CodingKeys: String, CodingKey {
        case status, bundleId, capabilities, simulatorUdid, observationBridge, webViewBridge
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(String.self, forKey: .status)
        bundleId = try values.decodeIfPresent(String.self, forKey: .bundleId)
        capabilities = try values.decodeIfPresent(Set<String>.self, forKey: .capabilities) ?? []
        simulatorUdid = try values.decodeIfPresent(String.self, forKey: .simulatorUdid)
        // A malformed bridge object degrades to "absent" rather than hiding the whole SDK.
        observationBridge = try? values.decodeIfPresent(ObservationBridgeState.self, forKey: .observationBridge)
        webViewBridge = try? values.decodeIfPresent(WebViewBridgeState.self, forKey: .webViewBridge)
    }
}
