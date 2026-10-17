import AutoMobileSdkWire
import Foundation

public protocol SdkHierarchyFetching: Sendable {
    /// Fetch the latest cached hierarchy (fast).
    func fetchHierarchy() async -> SdkViewHierarchy?
    /// Request a fresh hierarchy walk (slower).
    func fetchFreshHierarchy() async -> SdkViewHierarchy?
    /// Preserve hierarchy failures separately from an SDK that is unavailable.
    func fetchFreshHierarchyResult() async -> SdkHierarchyFetchResult
    /// Fetch lightweight server metadata, including the owning app bundle ID.
    func fetchServerInfo() async -> SdkHierarchyServerInfo?
    /// Whether the SDK hierarchy server is reachable.
    func isAvailable() async -> Bool
    /// Replace network mock rules in the in-app SDK.
    func setMockRules(_ rules: [NetworkMockRuleDTO]) async -> Bool
    /// `setMockRules` that also returns the rules the SDK's regex engine rejected (issue #10101).
    func pushMockRules(_ rules: [NetworkMockRuleDTO]) async -> SdkMockRulesOutcome
    func setNetworkFaultRules(_ rules: [NetworkFaultRuleDTO]) async -> Bool
    /// Replace active network error simulation in the in-app SDK.
    func setNetworkErrorSimulation(_ config: NetworkErrorSimulationDTO) async -> Bool
    /// nil means transport failure; false means the SDK found no handler.
    func performMagicTap() async -> Bool?
    /// POST a trigger body to the SDK's `/trigger` route; nil means the SDK was unreachable.
    func sendTrigger(_ body: Data) async -> SdkTriggerReply?
    /// Draw a highlight in the in-app SDK process.
    func addHighlight(id: String, shape: HighlightShape) async -> SdkHighlightOutcome
}

public enum SdkHierarchyFetchResult: Sendable {
    case hierarchy(SdkViewHierarchy)
    /// No SDK hierarchy server answered. An app without the SDK is not a failure.
    case unavailable
    /// The SDK hierarchy request timed out or its response could not provide a hierarchy.
    case failed(SdkHierarchyFetchFailure)
}

public enum SdkHierarchyFetchFailure: Sendable, Equatable {
    case timedOut
    case httpStatus(Int)
    case undecodable(reason: String)

    public var reason: String {
        switch self {
        case .timedOut: "SDK hierarchy request timed out"
        case let .httpStatus(code): "SDK hierarchy request returned HTTP status \(code)"
        case let .undecodable(reason): "SDK hierarchy response could not be decoded: \(reason)"
        }
    }
}

/// What the in-app SDK did with a pushed mock-rule list (issue #10101). `rejectedMockIds` is nil when the
/// SDK did not report (it predates the report): the host then says "sent, not confirmed" rather than
/// claiming every rule was installed. An empty list is a report that nothing was rejected.
public struct SdkMockRulesOutcome: Sendable, Equatable {
    public let ok: Bool
    public let rejectedMockIds: [String]?
    public let rejectedReasons: [String: String]?

    public init(ok: Bool, rejectedMockIds: [String]? = nil, rejectedReasons: [String: String]? = nil) {
        self.ok = ok
        self.rejectedMockIds = rejectedMockIds
        self.rejectedReasons = rejectedReasons
    }
}

extension SdkHierarchyFetching {
    public func fetchFreshHierarchyResult() async -> SdkHierarchyFetchResult {
        guard let hierarchy = await fetchFreshHierarchy() else { return .unavailable }
        return .hierarchy(hierarchy)
    }

    /// Fetchers that cannot see the SDK's reply body (stubs, older conformers) report only success.
    public func pushMockRules(_ rules: [NetworkMockRuleDTO]) async -> SdkMockRulesOutcome {
        SdkMockRulesOutcome(ok: await setMockRules(rules))
    }

    /// Older implementations have no Magic Tap bridge.
    public func performMagicTap() async -> Bool? { nil }
    /// Older implementations have no trigger bridge.
    public func sendTrigger(_: Data) async -> SdkTriggerReply? { nil }
}
