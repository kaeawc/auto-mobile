import Foundation

/// UI Element information (matching Android's UIElementInfo).
///
/// The custom `CodingKeys` map camelCase Swift properties to the kebab-case JSON
/// keys the TS client reads (`content-desc`, `resource-id`, `semantic-links`,
/// `accessibility-focused`, `long-clickable`, `view-id`, `state-description`,
/// `error-message`, `hint-text`). These names are the frozen wire contract and are
/// reproduced verbatim from the reference target.
public struct UIElementInfo: Codable, Sendable {
    public let text: String?
    public let value: String?
    public let textSize: Float?
    public let contentDesc: String?
    public let resourceId: String?
    public let className: String?
    public let bounds: ElementBounds?
    public let clickable: String?
    public let enabled: String?
    public let focusable: String?
    public let focused: String?
    public let accessibilityFocused: String?
    public let scrollable: String?
    public let password: String?
    public let checkable: String?
    public let checked: String?
    public let selected: String?
    public let longClickable: String?
    public let semanticLinks: [SemanticLink]?
    public let testTag: String?
    public let role: String?
    public let stateDescription: String?
    public let errorMessage: String?
    public let hintText: String?
    public let viewId: String?
    public let extras: [String: String]?
    public let actions: [String]?
    public let node: [UIElementInfo]?

    enum CodingKeys: String, CodingKey {
        case text, value, textSize, className, bounds, clickable, enabled
        case focusable, focused, scrollable, password, checkable, checked
        case selected, actions, node, role, testTag, extras
        case semanticLinks = "semantic-links"
        case viewId = "view-id"
        case contentDesc = "content-desc"
        case resourceId = "resource-id"
        case accessibilityFocused = "accessibility-focused"
        case longClickable = "long-clickable"
        case stateDescription = "state-description"
        case errorMessage = "error-message"
        case hintText = "hint-text"
    }

    public init(
        text: String? = nil,
        value: String? = nil,
        textSize: Float? = nil,
        contentDesc: String? = nil,
        resourceId: String? = nil,
        className: String? = nil,
        bounds: ElementBounds? = nil,
        clickable: String? = nil,
        enabled: String? = nil,
        focusable: String? = nil,
        focused: String? = nil,
        accessibilityFocused: String? = nil,
        scrollable: String? = nil,
        password: String? = nil,
        checkable: String? = nil,
        checked: String? = nil,
        selected: String? = nil,
        longClickable: String? = nil,
        semanticLinks: [SemanticLink]? = nil,
        testTag: String? = nil,
        role: String? = nil,
        stateDescription: String? = nil,
        errorMessage: String? = nil,
        hintText: String? = nil,
        viewId: String? = nil,
        extras: [String: String]? = nil,
        actions: [String]? = nil,
        node: [UIElementInfo]? = nil
    ) {
        self.text = text
        self.value = value
        self.textSize = textSize
        self.contentDesc = contentDesc
        self.resourceId = resourceId
        self.className = className
        self.bounds = bounds
        self.clickable = clickable
        self.enabled = enabled
        self.focusable = focusable
        self.focused = focused
        self.accessibilityFocused = accessibilityFocused
        self.scrollable = scrollable
        self.password = password
        self.checkable = checkable
        self.checked = checked
        self.selected = selected
        self.longClickable = longClickable
        self.semanticLinks = semanticLinks
        self.testTag = testTag
        self.role = role
        self.stateDescription = stateDescription
        self.errorMessage = errorMessage
        self.hintText = hintText
        self.viewId = viewId
        self.extras = extras
        self.actions = actions
        self.node = node
    }
}
