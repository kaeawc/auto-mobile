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
