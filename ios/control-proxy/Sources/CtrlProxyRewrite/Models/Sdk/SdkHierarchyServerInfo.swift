import Foundation

/// Lightweight metadata exposed by the in-app SDK hierarchy server's `/health`
/// endpoint. Ported from the reference `SdkHierarchyModels.swift`; already an
/// immutable value type, so `Sendable`.
public struct SdkHierarchyServerInfo: Codable, Sendable {
    public let status: String
    public let bundleId: String?
    public let capabilities: Set<String>

    public init(status: String, bundleId: String?, capabilities: Set<String> = []) {
        self.status = status
        self.bundleId = bundleId
        self.capabilities = capabilities
    }
}
