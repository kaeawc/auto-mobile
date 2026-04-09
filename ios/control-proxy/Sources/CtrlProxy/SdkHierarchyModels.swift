import Foundation

// MARK: - SDK View Hierarchy Models
// Duplicated from AutoMobileSDK since the two packages have no shared dependency.

/// Complete snapshot of the in-process UIView hierarchy from the SDK.
public struct SdkViewHierarchy: Codable, Sendable {
    public let timestamp: Int64
    public let bundleId: String?
    public let screenScale: Float
    public let screenWidth: Int
    public let screenHeight: Int
    public let root: SdkViewNode?
}

/// A single node in the SDK's UIView hierarchy tree.
public struct SdkViewNode: Codable, Sendable {
    public let className: String
    public let bounds: SdkBounds
    public let accessibilityLabel: String?
    public let accessibilityIdentifier: String?
    public let isAccessibilityElement: Bool
    public let accessibilityElementsHidden: Bool
    public let accessibilityTraits: [String]
    public let accessibilityCustomActions: [String]
    public let gestureRecognizers: [SdkGestureInfo]
    public let alpha: Float
    public let backgroundColor: String?
    public let cornerRadius: Float
    public let isHidden: Bool
    public let isUserInteractionEnabled: Bool
    public let hasTapTarget: Bool
    public let isOccluded: Bool
    public let children: [SdkViewNode]?

    public init(
        className: String,
        bounds: SdkBounds,
        accessibilityLabel: String? = nil,
        accessibilityIdentifier: String? = nil,
        isAccessibilityElement: Bool = false,
        accessibilityElementsHidden: Bool = false,
        accessibilityTraits: [String] = [],
        accessibilityCustomActions: [String] = [],
        gestureRecognizers: [SdkGestureInfo] = [],
        alpha: Float = 1.0,
        backgroundColor: String? = nil,
        cornerRadius: Float = 0,
        isHidden: Bool = false,
        isUserInteractionEnabled: Bool = true,
        hasTapTarget: Bool = false,
        isOccluded: Bool = false,
        children: [SdkViewNode]? = nil
    ) {
        self.className = className
        self.bounds = bounds
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityIdentifier = accessibilityIdentifier
        self.isAccessibilityElement = isAccessibilityElement
        self.accessibilityElementsHidden = accessibilityElementsHidden
        self.accessibilityTraits = accessibilityTraits
        self.accessibilityCustomActions = accessibilityCustomActions
        self.gestureRecognizers = gestureRecognizers
        self.alpha = alpha
        self.backgroundColor = backgroundColor
        self.cornerRadius = cornerRadius
        self.isHidden = isHidden
        self.isUserInteractionEnabled = isUserInteractionEnabled
        self.hasTapTarget = hasTapTarget
        self.isOccluded = isOccluded
        self.children = children
    }
}

/// Element bounds in root view coordinates (matches SDK format).
public struct SdkBounds: Codable, Sendable, Hashable {
    public let left: Int
    public let top: Int
    public let right: Int
    public let bottom: Int

    public var width: Int { right - left }
    public var height: Int { bottom - top }
}

/// Gesture recognizer info from the SDK.
public struct SdkGestureInfo: Codable, Sendable {
    public let type: String
    public let isEnabled: Bool
}
