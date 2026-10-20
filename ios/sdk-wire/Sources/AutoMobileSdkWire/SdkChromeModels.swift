import Foundation

/// UIWindow safe area in the same point coordinate space as view bounds.
public struct SdkEdgeInsets: Codable, Sendable {
    public let top: Double
    public let right: Double
    public let bottom: Double
    public let left: Double

    public init(top: Double, right: Double, bottom: Double, left: Double) {
        self.top = top
        self.right = right
        self.bottom = bottom
        self.left = left
    }
}

/// Physical display-cutout metadata. UIKit has no public cutout classification or
/// bounding-rectangle API, so the SDK currently reports an explicit `unknown`.
public struct SdkDisplayCutoutInfo: Codable, Sendable {
    public let classification: String
    public let bounds: [SdkBounds]?

    public static let unknown = SdkDisplayCutoutInfo(classification: "unknown")

    public init(classification: String, bounds: [SdkBounds]? = nil) {
        self.classification = classification
        self.bounds = bounds
    }
}

/// System-chrome presentation captured from the foreground app's UIWindowScene.
public struct SdkSystemChrome: Codable, Sendable {
    public let visibility: String
    public let statusBar: String
    /// The top view controller's preference, not observed home-indicator visibility.
    public let homeIndicatorAutoHideRequested: Bool?
    public let source: String

    public init(
        visibility: String,
        statusBar: String,
        homeIndicatorAutoHideRequested: Bool? = nil,
        source: String
    ) {
        self.visibility = visibility
        self.statusBar = statusBar
        self.homeIndicatorAutoHideRequested = homeIndicatorAutoHideRequested
        self.source = source
    }
}

/// Describes a gesture recognizer attached to a view.
public struct SdkGestureInfo: Codable, Sendable {
    public let type: String
    public let isEnabled: Bool

    public init(type: String, isEnabled: Bool) {
        self.type = type
        self.isEnabled = isEnabled
    }
}
