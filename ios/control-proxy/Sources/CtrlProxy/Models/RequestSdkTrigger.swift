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
}

extension RequestSdkAction: CommandPayload {}
