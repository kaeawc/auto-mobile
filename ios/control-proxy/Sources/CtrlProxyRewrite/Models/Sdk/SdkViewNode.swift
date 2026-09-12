import Foundation

/// A single node in the SDK's UIView hierarchy tree.
///
/// The custom `init(from:)` decodes every optional field tolerantly
/// (`decodeIfPresent` + defaults) so older/newer SDK payloads stay compatible
/// (#3924) — reproduced verbatim from the reference target.
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
    /// Inline semantic links the in-app SDK discovered on this text element
    /// (issue #5560). The runner projects these onto the merged element's
    /// `semantic-links` and uses the optional per-link center point to activate a
    /// specific inline link by coordinate.
    public let semanticLinks: [SdkSemanticLink]?
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
        semanticLinks: [SdkSemanticLink]? = nil,
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
        self.semanticLinks = semanticLinks
        self.children = children
    }

    private enum CodingKeys: String, CodingKey {
        case className, bounds, accessibilityLabel, accessibilityIdentifier,
             isAccessibilityElement, isAccessibilityFocused, accessibilityElementsHidden,
             accessibilityTraits, accessibilityCustomActions, gestureRecognizers,
             alpha, backgroundColor, cornerRadius,
             borderColor, borderWidth, isLayerNode,
             isHidden, isUserInteractionEnabled, hasTapTarget, isOccluded, semanticLinks, children
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        className = try c.decode(String.self, forKey: .className)
        bounds = try c.decode(SdkBounds.self, forKey: .bounds)
        accessibilityLabel = try c.decodeIfPresent(String.self, forKey: .accessibilityLabel)
        accessibilityIdentifier = try c.decodeIfPresent(String.self, forKey: .accessibilityIdentifier)
        isAccessibilityElement = try c.decodeIfPresent(Bool.self, forKey: .isAccessibilityElement) ?? false
        isAccessibilityFocused = try c.decodeIfPresent(Bool.self, forKey: .isAccessibilityFocused) ?? false
        accessibilityElementsHidden = try c.decodeIfPresent(Bool.self, forKey: .accessibilityElementsHidden) ?? false
        accessibilityTraits = try c.decodeIfPresent([String].self, forKey: .accessibilityTraits) ?? []
        accessibilityCustomActions = try c.decodeIfPresent([String].self, forKey: .accessibilityCustomActions) ?? []
        gestureRecognizers = try c.decodeIfPresent([SdkGestureInfo].self, forKey: .gestureRecognizers) ?? []
        alpha = try c.decodeIfPresent(Float.self, forKey: .alpha) ?? 1.0
        backgroundColor = try c.decodeIfPresent(String.self, forKey: .backgroundColor)
        cornerRadius = try c.decodeIfPresent(Float.self, forKey: .cornerRadius) ?? 0
        borderColor = try c.decodeIfPresent(String.self, forKey: .borderColor)
        borderWidth = try c.decodeIfPresent(Float.self, forKey: .borderWidth) ?? 0
        isLayerNode = try c.decodeIfPresent(Bool.self, forKey: .isLayerNode) ?? false
        isHidden = try c.decodeIfPresent(Bool.self, forKey: .isHidden) ?? false
        isUserInteractionEnabled = try c.decodeIfPresent(Bool.self, forKey: .isUserInteractionEnabled) ?? true
        hasTapTarget = try c.decodeIfPresent(Bool.self, forKey: .hasTapTarget) ?? false
        isOccluded = try c.decodeIfPresent(Bool.self, forKey: .isOccluded) ?? false
        semanticLinks = try c.decodeIfPresent([SdkSemanticLink].self, forKey: .semanticLinks)
        children = try c.decodeIfPresent([SdkViewNode].self, forKey: .children)
    }
}
