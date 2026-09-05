import Foundation

/// View hierarchy structure (matching Android's ViewHierarchy). The `hierarchy_update`
/// / `request_hierarchy` result payload; the deep element tree the TS client renders.
public struct ViewHierarchy: Codable, Sendable {
    public let updatedAt: Int64
    public let packageName: String?
    public let hierarchy: UIElementInfo?
    public let windowInfo: WindowInfo?
    public let windows: [WindowInfo]?
    public let screenScale: Float?
    public let screenWidth: Int?
    public let screenHeight: Int?
    /// Ratio between the point-space bounds reported here and the physical screenshot
    /// pixels (`UIScreen.nativeScale`). Distinct from `screenScale` (`UIScreen.scale`):
    /// Display Zoom changes `nativeScale` but not `scale`, and screenshots are rendered
    /// at native scale, so this converts reported bounds to screenshot pixels (#4548).
    public let nativeScale: Double?
    /// Physical screenshot pixel width: `round(screenWidth * nativeScale)` (#4548).
    public let pixelWidth: Int?
    /// Physical screenshot pixel height: `round(screenHeight * nativeScale)` (#4548).
    public let pixelHeight: Int?
    /// Device display rotation captured with this hierarchy: Android-compatible 0...3.
    public let rotation: Int?
    public let systemInsets: EdgeInsetsInfo?
    public let insets: ObservationInsetsInfo
    public let error: String?
    public let fallbackToSpringboard: Bool?

    public init(
        updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        packageName: String? = nil,
        hierarchy: UIElementInfo? = nil,
        windowInfo: WindowInfo? = nil,
        windows: [WindowInfo]? = nil,
        screenScale: Float? = nil,
        screenWidth: Int? = nil,
        screenHeight: Int? = nil,
        nativeScale: Double? = nil,
        pixelWidth: Int? = nil,
        pixelHeight: Int? = nil,
        rotation: Int? = nil,
        systemInsets: EdgeInsetsInfo? = nil,
        insets: ObservationInsetsInfo = .unavailable,
        error: String? = nil,
        fallbackToSpringboard: Bool? = nil
    ) {
        self.updatedAt = updatedAt
        self.packageName = packageName
        self.hierarchy = hierarchy
        self.windowInfo = windowInfo
        self.windows = windows
        self.screenScale = screenScale
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.nativeScale = nativeScale
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.rotation = rotation
        self.systemInsets = systemInsets
        self.insets = insets
        self.error = error
        self.fallbackToSpringboard = fallbackToSpringboard
    }
}
