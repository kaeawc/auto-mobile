import Foundation

// MARK: - SDK View Hierarchy Models
//
// Duplicated from AutoMobileSDK since the two packages have no shared dependency
// (ported from the reference target's SdkHierarchyModels.swift). Already-Sendable
// value types; split one-per-file under Models/Sdk/.

/// Complete snapshot of the in-process UIView hierarchy from the SDK.
public struct SdkViewHierarchy: Codable, Sendable {
    public let timestamp: Int64
    public let bundleId: String?
    public let screenScale: Float
    public let screenWidth: Int
    public let screenHeight: Int
    public let safeAreaInsets: SdkEdgeInsets?
    public let systemChrome: SdkSystemChrome?
    public let root: SdkViewNode?

    public init(
        timestamp: Int64,
        bundleId: String?,
        screenScale: Float,
        screenWidth: Int,
        screenHeight: Int,
        safeAreaInsets: SdkEdgeInsets? = nil,
        systemChrome: SdkSystemChrome? = nil,
        root: SdkViewNode?
    ) {
        self.timestamp = timestamp
        self.bundleId = bundleId
        self.screenScale = screenScale
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.safeAreaInsets = safeAreaInsets
        self.systemChrome = systemChrome
        self.root = root
    }
}
