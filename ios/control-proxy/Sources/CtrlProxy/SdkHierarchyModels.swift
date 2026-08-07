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

public struct SdkEdgeInsets: Codable, Sendable {
    public let top: Double
    public let right: Double
    public let bottom: Double
    public let left: Double
}

public struct SdkSystemChrome: Codable, Sendable {
    public let visibility: String
    public let statusBar: String
    public let homeIndicatorAutoHideRequested: Bool?
    public let source: String
}

/// Lightweight metadata exposed by the SDK hierarchy server.
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

/// A single node in the SDK's UIView hierarchy tree.
public struct SdkViewNode: Codable, Sendable {
    public let className: String
    public let bounds: SdkBounds
    public let accessibilityLabel: String?
    public let accessibilityIdentifier: String?
    public let isAccessibilityElement: Bool
    /// Whether this element holds the VoiceOver cursor. Reported by the in-app SDK
    /// (`accessibilityElementIsFocused()`), which this out-of-process runner cannot
    /// read itself; decoded tolerantly so older SDK payloads stay compatible (#3924).
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
