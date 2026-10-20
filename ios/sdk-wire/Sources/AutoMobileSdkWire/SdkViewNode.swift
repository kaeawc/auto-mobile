import Foundation

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
    /// Inline accessibility links discovered on this text element (issue #5560).
    /// Non-nil only for text-bearing views (`UITextView`/`UILabel` attributed
    /// text, or SwiftUI text whose inline links surface as `.link`-trait
    /// accessibility children). The runner projects these onto the owning
    /// element's `semantic-links` for Android parity.
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
        let container = try decoder.container(keyedBy: CodingKeys.self)
        className = try container.decode(String.self, forKey: .className)
        bounds = try container.decode(SdkBounds.self, forKey: .bounds)
        accessibilityLabel = try container.decodeIfPresent(String.self, forKey: .accessibilityLabel)
        accessibilityIdentifier = try container.decodeIfPresent(String.self, forKey: .accessibilityIdentifier)
        isAccessibilityElement = try container.decodeIfPresent(Bool.self, forKey: .isAccessibilityElement) ?? false
        isAccessibilityFocused = try container.decodeIfPresent(Bool.self, forKey: .isAccessibilityFocused) ?? false
        accessibilityElementsHidden = try container
            .decodeIfPresent(Bool.self, forKey: .accessibilityElementsHidden) ?? false
        accessibilityTraits = try container.decodeIfPresent([String].self, forKey: .accessibilityTraits) ?? []
        accessibilityCustomActions = try container
            .decodeIfPresent([String].self, forKey: .accessibilityCustomActions) ?? []
        gestureRecognizers = try container.decodeIfPresent([SdkGestureInfo].self, forKey: .gestureRecognizers) ?? []
        alpha = try container.decodeIfPresent(Float.self, forKey: .alpha) ?? 1.0
        backgroundColor = try container.decodeIfPresent(String.self, forKey: .backgroundColor)
        cornerRadius = try container.decodeIfPresent(Float.self, forKey: .cornerRadius) ?? 0
        borderColor = try container.decodeIfPresent(String.self, forKey: .borderColor)
        borderWidth = try container.decodeIfPresent(Float.self, forKey: .borderWidth) ?? 0
        isLayerNode = try container.decodeIfPresent(Bool.self, forKey: .isLayerNode) ?? false
        isHidden = try container.decodeIfPresent(Bool.self, forKey: .isHidden) ?? false
        isUserInteractionEnabled = try container.decodeIfPresent(Bool.self, forKey: .isUserInteractionEnabled) ?? true
        hasTapTarget = try container.decodeIfPresent(Bool.self, forKey: .hasTapTarget) ?? false
        isOccluded = try container.decodeIfPresent(Bool.self, forKey: .isOccluded) ?? false
        semanticLinks = try container.decodeIfPresent([SdkSemanticLink].self, forKey: .semanticLinks)
        children = try container.decodeIfPresent([SdkViewNode].self, forKey: .children)
    }
}
