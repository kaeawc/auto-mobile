import Foundation

/// `request_sdk_trigger`: forward a named trigger to a module in the foreground app's
/// in-app SDK through its `POST /trigger` route (#1580). `payloadJson` is the trigger
/// payload as a JSON object string, so the runner relays it without a JSON value model.
public struct RequestSdkTrigger: Decodable, Sendable {
    public var requestId: String?
    public var module: String?
    public var trigger: String?
    public var payloadJson: String?
}

extension RequestSdkTrigger: CommandPayload {}

/// `request_sdk_action`: perform one observation-bridge action in the foreground app's in-app SDK
/// (#5159). `actionJson` is one JSON-encoded `AutoMobileAction`, relayed as a string like
/// `RequestSdkTrigger.payloadJson`, so the request wire stays flat.
public struct RequestSdkAction: Decodable, Sendable {
    public var requestId: String?
    public var actionJson: String?
    /// Optional host reply budget in milliseconds; absent on older daemons.
    public var timeoutMs: Double?
}

extension RequestSdkAction: CommandPayload {}

/// `request_sdk_web_snapshot`: the latest bounded snapshot of one opted-in WKWebView in the
/// foreground app's SDK (#5162). A nil `webViewId` names the first registered web view.
public struct RequestSdkWebSnapshot: Decodable, Sendable {
    public var requestId: String?
    public var webViewId: String?
}

extension RequestSdkWebSnapshot: CommandPayload {}

/// `request_sdk_web_action`: perform one bounded web action (#5162). `actionJson` is one
/// JSON-encoded `AutoMobileWebControlAction`, which has no JavaScript case.
public struct RequestSdkWebAction: Decodable, Sendable {
    public var requestId: String?
    public var webViewId: String?
    public var actionJson: String?
}

extension RequestSdkWebAction: CommandPayload {}
