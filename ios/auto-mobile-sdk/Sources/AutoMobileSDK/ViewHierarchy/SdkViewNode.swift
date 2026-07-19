import Foundation

// MARK: - View Hierarchy

/// Complete snapshot of the in-process UIView hierarchy.
public struct SdkViewHierarchy: Codable, Sendable {
    public let timestamp: Int64
    public let bundleId: String?
    public let screenScale: Float
    public let screenWidth: Int
    public let screenHeight: Int
    public let root: SdkViewNode?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        bundleId: String? = nil,
        screenScale: Float,
        screenWidth: Int,
        screenHeight: Int,
        root: SdkViewNode?
    ) {
        self.timestamp = timestamp
        self.bundleId = bundleId
        self.screenScale = screenScale
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.root = root
    }
}

// MARK: - View Node

/// A single node in the in-process UIView hierarchy tree.
/// Contains properties only available from within the app process
/// (gesture recognizers, traits, custom actions, background color, etc.).
public struct SdkViewNode: Codable, Sendable {
    public let className: String
    public let bounds: SdkBounds
    public let accessibilityLabel: String?
    public let accessibilityIdentifier: String?
    public let isAccessibilityElement: Bool
    /// Whether this element currently holds the VoiceOver cursor. Captured in-app
    /// via `accessibilityElementIsFocused()`, which the out-of-process runner
    /// cannot read itself — this is the signal that lets AutoMobile report
    /// `accessibilityFocusedElement` on iOS (#3924).
    public let isAccessibilityFocused: Bool
    public let accessibilityElementsHidden: Bool
    public let accessibilityTraits: [String]
    public let accessibilityCustomActions: [String]
    public let gestureRecognizers: [SdkGestureInfo]
    public let alpha: Float
    public let backgroundColor: String?
    public let cornerRadius: Float
    public let borderColor: String?
    public let borderWidth: Float
    public let isLayerNode: Bool
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
        isAccessibilityFocused: Bool = false,
        accessibilityElementsHidden: Bool = false,
        accessibilityTraits: [String] = [],
        accessibilityCustomActions: [String] = [],
        gestureRecognizers: [SdkGestureInfo] = [],
        alpha: Float = 1.0,
        backgroundColor: String? = nil,
        cornerRadius: Float = 0,
        borderColor: String? = nil,
        borderWidth: Float = 0,
        isLayerNode: Bool = false,
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
        self.isAccessibilityFocused = isAccessibilityFocused
        self.accessibilityElementsHidden = accessibilityElementsHidden
        self.accessibilityTraits = accessibilityTraits
        self.accessibilityCustomActions = accessibilityCustomActions
        self.gestureRecognizers = gestureRecognizers
        self.alpha = alpha
        self.backgroundColor = backgroundColor
        self.cornerRadius = cornerRadius
        self.borderColor = borderColor
        self.borderWidth = borderWidth
        self.isLayerNode = isLayerNode
        self.isHidden = isHidden
        self.isUserInteractionEnabled = isUserInteractionEnabled
        self.hasTapTarget = hasTapTarget
        self.isOccluded = isOccluded
        self.children = children
    }

    private enum CodingKeys: String, CodingKey {
        case className, bounds, accessibilityLabel, accessibilityIdentifier,
             isAccessibilityElement, isAccessibilityFocused, accessibilityElementsHidden,
             accessibilityTraits, accessibilityCustomActions, gestureRecognizers,
             alpha, backgroundColor, cornerRadius,
             borderColor, borderWidth, isLayerNode,
             isHidden, isUserInteractionEnabled, hasTapTarget, isOccluded, children
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.className = try c.decode(String.self, forKey: .className)
        self.bounds = try c.decode(SdkBounds.self, forKey: .bounds)
        self.accessibilityLabel = try c.decodeIfPresent(String.self, forKey: .accessibilityLabel)
        self.accessibilityIdentifier = try c.decodeIfPresent(String.self, forKey: .accessibilityIdentifier)
        self.isAccessibilityElement = try c.decodeIfPresent(Bool.self, forKey: .isAccessibilityElement) ?? false
        self.isAccessibilityFocused = try c.decodeIfPresent(Bool.self, forKey: .isAccessibilityFocused) ?? false
        self.accessibilityElementsHidden = try c.decodeIfPresent(Bool.self, forKey: .accessibilityElementsHidden) ?? false
        self.accessibilityTraits = try c.decodeIfPresent([String].self, forKey: .accessibilityTraits) ?? []
        self.accessibilityCustomActions = try c.decodeIfPresent([String].self, forKey: .accessibilityCustomActions) ?? []
        self.gestureRecognizers = try c.decodeIfPresent([SdkGestureInfo].self, forKey: .gestureRecognizers) ?? []
        self.alpha = try c.decodeIfPresent(Float.self, forKey: .alpha) ?? 1.0
        self.backgroundColor = try c.decodeIfPresent(String.self, forKey: .backgroundColor)
        self.cornerRadius = try c.decodeIfPresent(Float.self, forKey: .cornerRadius) ?? 0
        self.borderColor = try c.decodeIfPresent(String.self, forKey: .borderColor)
        self.borderWidth = try c.decodeIfPresent(Float.self, forKey: .borderWidth) ?? 0
        self.isLayerNode = try c.decodeIfPresent(Bool.self, forKey: .isLayerNode) ?? false
        self.isHidden = try c.decodeIfPresent(Bool.self, forKey: .isHidden) ?? false
        self.isUserInteractionEnabled = try c.decodeIfPresent(Bool.self, forKey: .isUserInteractionEnabled) ?? true
        self.hasTapTarget = try c.decodeIfPresent(Bool.self, forKey: .hasTapTarget) ?? false
        self.isOccluded = try c.decodeIfPresent(Bool.self, forKey: .isOccluded) ?? false
        self.children = try c.decodeIfPresent([SdkViewNode].self, forKey: .children)
    }
}

// MARK: - Bounds

/// Element bounds in root view coordinates.
public struct SdkBounds: Codable, Sendable, Hashable {
    public let left: Int
    public let top: Int
    public let right: Int
    public let bottom: Int

    public init(left: Int, top: Int, right: Int, bottom: Int) {
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom
    }

    public var width: Int { right - left }
    public var height: Int { bottom - top }
}

// MARK: - Gesture Info

/// Describes a gesture recognizer attached to a view.
public struct SdkGestureInfo: Codable, Sendable {
    public let type: String
    public let isEnabled: Bool

    public init(type: String, isEnabled: Bool) {
        self.type = type
        self.isEnabled = isEnabled
    }
}
