import Foundation

/// Complete snapshot of the in-process UIView hierarchy.
public struct SdkViewHierarchy: Codable, Sendable {
    public let timestamp: Int64
    public let bundleId: String?
    public let screenScale: Float
    public let screenWidth: Int
    public let screenHeight: Int
    /** UIWindow safe area in the same point coordinate space as view bounds. */
    public let safeAreaInsets: SdkEdgeInsets?
    /**
     * Physical display-cutout metadata. UIKit has no public cutout classification
     * or bounding-rectangle API, so the SDK currently reports explicit `unknown`.
     */
    public let displayCutoutInfo: SdkDisplayCutoutInfo?
    /** Current status-bar presentation for this app window. */
    public let systemChrome: SdkSystemChrome?
    public let root: SdkViewNode?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        bundleId: String? = nil,
        screenScale: Float,
        screenWidth: Int,
        screenHeight: Int,
        safeAreaInsets: SdkEdgeInsets? = nil,
        displayCutoutInfo: SdkDisplayCutoutInfo? = nil,
        systemChrome: SdkSystemChrome? = nil,
        root: SdkViewNode?
    ) {
        self.timestamp = timestamp
        self.bundleId = bundleId
        self.screenScale = screenScale
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.safeAreaInsets = safeAreaInsets
        self.displayCutoutInfo = displayCutoutInfo
        self.systemChrome = systemChrome
        self.root = root
    }
}
