import Foundation

/// Protocol for fetching the SDK view hierarchy on demand from the target app. Ported
/// from the reference `Protocols.swift`; every method is now `async` (the reference
/// blocked a `URLSession` completion on a `DispatchSemaphore`). Refines `Sendable` so a
/// Phase-6 `Sendable` CommandHandler can hold it.
public protocol SdkHierarchyFetching: Sendable {
    /// Fetch the latest cached hierarchy (fast).
    func fetchHierarchy() async -> SdkViewHierarchy?
    /// Request a fresh hierarchy walk (slower).
    func fetchFreshHierarchy() async -> SdkViewHierarchy?
    /// Fetch lightweight server metadata, including the owning app bundle ID.
    func fetchServerInfo() async -> SdkHierarchyServerInfo?
    /// Whether the SDK hierarchy server is reachable.
    func isAvailable() async -> Bool
    /// Replace network mock rules in the in-app SDK.
    func setMockRules(_ rules: [NetworkMockRuleDTO]) async -> Bool
    func setNetworkFaultRules(_ rules: [NetworkFaultRuleDTO]) async -> Bool
    /// Replace active network error simulation in the in-app SDK.
    func setNetworkErrorSimulation(_ config: NetworkErrorSimulationDTO) async -> Bool
    /// Draw a highlight in the in-app SDK process.
    func addHighlight(id: String, shape: HighlightShape) async -> SdkHighlightOutcome
}
