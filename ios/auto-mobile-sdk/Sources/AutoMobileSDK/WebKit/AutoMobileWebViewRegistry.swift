import AutoMobileSdkWire
import Foundation
import os

/// What the web-view routes need from one opted-in web view (#5162). ``AutoMobileWebViewBridge``
/// conforms; tests use fakes.
protocol AutoMobileWebViewControlling: AnyObject, Sendable {
    var webViewId: String { get }
    var bridgeEntry: WebViewBridgeEntry { get }
    /// The latest snapshot the bridge accepted, already bounded and redacted by its policy.
    var latestSnapshot: AutoMobileWebSnapshot? { get }
    var maxMessageBytes: Int { get }
    /// Whether the page's current origin is allowed by the bridge's policy.
    var originAllowed: Bool { get }
    var contentProcessAvailable: Bool { get }
    func perform(_ action: AutoMobileWebControlAction) async -> AutoMobileWebActionResult
}

/// Holds the app's opted-in ``AutoMobileWebViewBridge`` instances so AutoMobile can discover them
/// (#5162).
///
/// Registration is explicit: the SDK never builds or registers a web-view bridge on its own, and
/// an app with none reports an empty list in its `/health` payload.
public final class AutoMobileWebViewRegistry: Sendable {
    public static let shared = AutoMobileWebViewRegistry()

    private let controllers = OSAllocatedUnfairLock<[any AutoMobileWebViewControlling]>(initialState: [])

    init() {}

    #if canImport(WebKit)
        /// Registers a bridge, replacing an earlier one with the same `webViewId`.
        public func register(_ bridge: AutoMobileWebViewBridge) {
            register(controller: bridge)
        }
    #endif

    func register(controller: any AutoMobileWebViewControlling) {
        controllers.withLock { list in
            list.removeAll { $0.webViewId == controller.webViewId }
            list.append(controller)
        }
    }

    /// Removes the bridge registered for `webViewId`, if any.
    public func unregister(webViewId: String) {
        controllers.withLock { list in list.removeAll { $0.webViewId == webViewId } }
    }

    /// The discovery state served in the SDK's `/health` payload, in registration order.
    public var state: WebViewBridgeState {
        WebViewBridgeState(webViews: controllers.withLock { $0 }.map(\.bridgeEntry))
    }

    /// The bridge for `webViewId`, or the first registered one when `webViewId` is nil.
    func controller(for webViewId: String?) -> (any AutoMobileWebViewControlling)? {
        controllers.withLock { list in
            guard let webViewId else { return list.first }
            return list.first { $0.webViewId == webViewId }
        }
    }
}
