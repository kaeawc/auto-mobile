import Foundation

// MARK: - WKWebView bridge values (#5162)

//
// Shared by the SDK, which serves them, and CtrlProxy, which relays them.

/// One opted-in web view, as the SDK's `/health` reports it.
public struct WebViewBridgeEntry: Codable, Equatable, Sendable {
    public let webViewId: String
    /// The last URL the bridge saw committed; nil before the first navigation.
    public let url: String?
    /// Origins the bridge's policy allows, sorted.
    public let allowedOrigins: [String]
    /// False after the web content process terminated and before the page loads again.
    public let contentProcessAvailable: Bool

    public init(webViewId: String, url: String?, allowedOrigins: [String], contentProcessAvailable: Bool) {
        self.webViewId = webViewId
        self.url = url
        self.allowedOrigins = allowedOrigins.sorted()
        self.contentProcessAvailable = contentProcessAvailable
    }
}

/// The SDK's registered web views, in registration order. Empty when none is registered.
public struct WebViewBridgeState: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1
    public let schemaVersion: Int
    public let webViews: [WebViewBridgeEntry]

    public init(schemaVersion: Int = WebViewBridgeState.currentSchemaVersion, webViews: [WebViewBridgeEntry]) {
        self.schemaVersion = schemaVersion
        self.webViews = webViews
    }

    public static let none = WebViewBridgeState(webViews: [])
}

/// A stable description of an interactive element in a web document.
public struct AutoMobileWebElement: Codable, Sendable, Equatable {
    public let id: String
    public let role: String?
    public let label: String?
    public let value: String?
    public let bounds: [Double]
    public let enabled: Bool
    public let visible: Bool
    public let focused: Bool

    public init(
        id: String,
        role: String? = nil,
        label: String? = nil,
        value: String? = nil,
        bounds: [Double] = [],
        enabled: Bool = true,
        visible: Bool = true,
        focused: Bool = false
    ) {
        self.id = id
        self.role = role
        self.label = label
        self.value = value
        self.bounds = bounds
        self.enabled = enabled
        self.visible = visible
        self.focused = focused
    }
}

/// A bounded DOM snapshot. Element IDs are valid only for this snapshot.
public struct AutoMobileWebSnapshot: Codable, Sendable, Equatable {
    public let snapshotId: String
    public let url: String?
    public let title: String?
    public let elements: [AutoMobileWebElement]

    public init(
        snapshotId: String = UUID().uuidString,
        url: String? = nil,
        title: String? = nil,
        elements: [AutoMobileWebElement] = []
    ) {
        self.snapshotId = snapshotId
        self.url = url
        self.title = title
        self.elements = elements
    }
}

/// `POST /webview/snapshot` body. A nil `webViewId` names the first registered web view.
public struct AutoMobileWebSnapshotRequest: Codable, Equatable, Sendable {
    public let webViewId: String?

    public init(webViewId: String? = nil) {
        self.webViewId = webViewId
    }
}

/// `POST /webview/snapshot` reply: the web view's latest bounded, redacted snapshot.
public struct AutoMobileWebSnapshotReply: Codable, Equatable, Sendable {
    public let webViewId: String
    public let snapshot: AutoMobileWebSnapshot

    public init(webViewId: String, snapshot: AutoMobileWebSnapshot) {
        self.webViewId = webViewId
        self.snapshot = snapshot
    }
}

/// The web actions an external controller may request. Each names the snapshot its element came
/// from. Arbitrary JavaScript has no case here, so it cannot be expressed on the wire.
public enum AutoMobileWebControlAction: Codable, Sendable, Equatable {
    case click(snapshotId: String, elementId: String)
    case focus(snapshotId: String, elementId: String)
    case insertText(snapshotId: String, elementId: String, text: String)
    case select(snapshotId: String, elementId: String, value: String)
    case scroll(snapshotId: String, elementId: String?, x: Double, y: Double)
    case setValue(snapshotId: String, elementId: String, text: String)
    case clear(snapshotId: String, elementId: String)
    case scrollIntoView(snapshotId: String, elementId: String)
    case submit(snapshotId: String, elementId: String)

    public var snapshotId: String {
        switch self {
        case let .click(id, _), let .focus(id, _), let .insertText(id, _, _), let .select(id, _, _),
             let .scroll(id, _, _, _), let .setValue(id, _, _), let .clear(id, _), let .scrollIntoView(id, _),
             let .submit(id, _):
            return id
        }
    }

    public var elementId: String? {
        switch self {
        case let .click(_, id), let .focus(_, id), let .insertText(_, id, _), let .select(_, id, _),
             let .setValue(_, id, _), let .clear(_, id), let .scrollIntoView(_, id), let .submit(_, id):
            return id
        case let .scroll(_, id, _, _):
            return id
        }
    }
}

/// `POST /webview/action` body.
public struct AutoMobileWebActionRequest: Codable, Equatable, Sendable {
    public let webViewId: String
    public let action: AutoMobileWebControlAction

    public init(webViewId: String, action: AutoMobileWebControlAction) {
        self.webViewId = webViewId
        self.action = action
    }
}

/// Result of one web action. A rejection names why; the action did not run.
public struct AutoMobileWebActionResult: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case accepted
        case rejected
    }

    /// The snapshot the action names is not one of the web view's recent snapshots.
    public static let staleSnapshotReason = "stale_snapshot"
    /// The element is missing from that snapshot, disabled or hidden.
    public static let elementNotActionableReason = "element_not_actionable"
    /// The page's origin or frame is not allowed by the bridge's policy.
    public static let disallowedOriginReason = "disallowed_origin"
    /// The web content process terminated and the page has not loaded again.
    public static let webProcessUnavailableReason = "web_process_unavailable"
    /// The bounded script raised a JavaScript error.
    public static let javascriptErrorReason = "javascript_error"

    public let status: Status
    public let reason: String?

    public init(status: Status, reason: String? = nil) {
        self.status = status
        self.reason = reason
    }

    public static func rejected(_ reason: String) -> AutoMobileWebActionResult {
        AutoMobileWebActionResult(status: .rejected, reason: reason)
    }
}
