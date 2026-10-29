import AutoMobileSdkWire
import Foundation

/// Result of `request_sdk_trigger`. `available` is false when the foreground app has no
/// in-app SDK with the `sdk-trigger` route. When the SDK answered, `statusCode` and the
/// SDK's structured error fields are relayed so the host can explain the failure.
public struct SdkTriggerResponse: Encodable, Sendable {
    public let type = ResponseType.sdkTriggerResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let statusCode: Int?
    public let sdkError: String?
    public let reason: String?
    public let registeredModules: [String]?
    public let supportedTriggers: [String]?
    public let error: String?
    public let totalTimeMs: Int64

    init(requestId: String?, available: Bool, reply: SdkTriggerReply?, error: String?, totalTimeMs: Int64) {
        self.requestId = requestId
        self.available = available
        success = available && reply?.statusCode == 200
        statusCode = reply?.statusCode
        sdkError = reply?.error
        reason = reply?.reason
        registeredModules = reply?.registeredModules
        supportedTriggers = reply?.supportedTriggers
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

/// The SDK's `POST /trigger` reply: the HTTP status plus its structured error fields.
public struct SdkTriggerReply: Equatable, Sendable {
    public let statusCode: Int
    public let error: String?
    public let reason: String?
    public let registeredModules: [String]?
    public let supportedTriggers: [String]?

    public init(
        statusCode: Int,
        error: String? = nil,
        reason: String? = nil,
        registeredModules: [String]? = nil,
        supportedTriggers: [String]? = nil
    ) {
        self.statusCode = statusCode
        self.error = error
        self.reason = reason
        self.registeredModules = registeredModules
        self.supportedTriggers = supportedTriggers
    }
}

/// Why an observation-bridge command did not produce a result (#5159).
public enum SdkBridgeFailure: String, Error, Sendable {
    /// No SDK in the foreground app or no registered bridge; the request was never sent.
    case bridgeUnavailable = "bridge_unavailable"
    /// The app resigned active before the SDK could serve the request.
    case appNotActive = "app_not_active"
    /// `actionJson` is missing or is not an `AutoMobileAction`.
    case invalidAction = "invalid_action"
    /// A sent request got no answer, or the SDK replied with a status or body this runner does not
    /// understand. The SDK may have acted.
    case badReply = "bad_reply"
    /// Web views (#5162): the page's origin or frame is not allowed by the bridge's policy.
    case disallowedOrigin = "disallowed_origin"
    /// Web views (#5162): the web content process terminated and the page has not loaded again.
    case webProcessUnavailable = "web_process_unavailable"
    /// Web views (#5162): the request or snapshot exceeds the bridge's message limit.
    case messageTooLarge = "message_too_large"
    /// Web views (#5162): the page has not posted a snapshot yet.
    case noSnapshot = "no_snapshot"

    var message: String {
        switch self {
        case .bridgeUnavailable:
            "The foreground app has no AutoMobile SDK observation bridge registered; nothing was sent."
        case .appNotActive: "The foreground app resigned active before the SDK could serve the request."
        case .invalidAction:
            "actionJson must be one JSON-encoded AutoMobileAction (for a web view: an "
                + "AutoMobileWebControlAction plus a webViewId)."
        case .badReply: "The in-app SDK did not answer a sent request, or its reply could not be decoded."
        case .disallowedOrigin: "The web view's page is on an origin or frame its bridge does not allow."
        case .webProcessUnavailable:
            "The web view's content process terminated and the page has not loaded again."
        case .messageTooLarge: "The web request or snapshot exceeds the bridge's message size limit."
        case .noSnapshot: "The web view has not produced a snapshot yet."
        }
    }
}

/// `sdk_observation_result`: the registered bridge's observation, or a typed failure.
public struct SdkObservationResponse: Encodable, Sendable {
    public let type = ResponseType.sdkObservationResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let observation: AutoMobileObservationSnapshot?
    public let failure: String?
    public let error: String?
    public let totalTimeMs: Int64

    init(requestId: String?, outcome: Result<AutoMobileObservationSnapshot, SdkBridgeFailure>, totalTimeMs: Int64) {
        self.requestId = requestId
        switch outcome {
        case let .success(observation):
            success = true
            available = true
            self.observation = observation
            failure = nil
            error = nil
        case let .failure(reason):
            success = false
            available = reason != .bridgeUnavailable
            observation = nil
            failure = reason.rawValue
            error = reason.message
        }
        self.totalTimeMs = totalTimeMs
    }
}

/// `sdk_action_result`: the bridge's result for one action, or a typed failure. A bridge rejection
/// (stale observation, element not actionable, unsupported action, overload, cancellation) is a
/// result with `success: false`, not a failure.
public struct SdkActionResponse: Encodable, Sendable {
    public let type = ResponseType.sdkActionResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let result: AutoMobileActionResult?
    public let failure: String?
    public let error: String?
    public let totalTimeMs: Int64

    init(requestId: String?, outcome: Result<AutoMobileActionResult, SdkBridgeFailure>, totalTimeMs: Int64) {
        self.requestId = requestId
        switch outcome {
        case let .success(result):
            success = result.status == .accepted
            available = true
            self.result = result
            failure = nil
            error = result.status == .accepted ? nil : result.reason
        case let .failure(reason):
            success = false
            available = reason != .bridgeUnavailable
            result = nil
            failure = reason.rawValue
            error = reason.message
        }
        self.totalTimeMs = totalTimeMs
    }
}

/// `sdk_web_snapshot_result` (#5162): one opted-in web view's latest bounded snapshot, or a typed
/// failure. `webViews` lists the app's registered web views from `/health`, when it was read.
public struct SdkWebSnapshotResponse: Encodable, Sendable {
    public let type = ResponseType.sdkWebSnapshotResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let webViewId: String?
    public let snapshot: AutoMobileWebSnapshot?
    public let webViews: [WebViewBridgeEntry]?
    public let failure: String?
    public let error: String?
    public let totalTimeMs: Int64

    init(
        requestId: String?,
        outcome: Result<AutoMobileWebSnapshotReply, SdkBridgeFailure>,
        webViews: [WebViewBridgeEntry]?,
        totalTimeMs: Int64
    ) {
        self.requestId = requestId
        self.webViews = webViews
        switch outcome {
        case let .success(reply):
            success = true
            available = true
            webViewId = reply.webViewId
            snapshot = reply.snapshot
            failure = nil
            error = nil
        case let .failure(reason):
            success = false
            available = reason != .bridgeUnavailable
            webViewId = nil
            snapshot = nil
            failure = reason.rawValue
            error = reason.message
        }
        self.totalTimeMs = totalTimeMs
    }
}

/// `sdk_web_action_result` (#5162): the web view's result for one bounded action, or a typed
/// failure. A stale snapshot, unactionable element, disallowed origin or dead content process is a
/// rejected result with `success: false`, not a failure.
public struct SdkWebActionResponse: Encodable, Sendable {
    public let type = ResponseType.sdkWebActionResult.rawValue
    public let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let result: AutoMobileWebActionResult?
    public let failure: String?
    public let error: String?
    public let totalTimeMs: Int64

    init(requestId: String?, outcome: Result<AutoMobileWebActionResult, SdkBridgeFailure>, totalTimeMs: Int64) {
        self.requestId = requestId
        switch outcome {
        case let .success(result):
            success = result.status == .accepted
            available = true
            self.result = result
            failure = nil
            error = result.status == .accepted ? nil : result.reason
        case let .failure(reason):
            success = false
            available = reason != .bridgeUnavailable
            result = nil
            failure = reason.rawValue
            error = reason.message
        }
        self.totalTimeMs = totalTimeMs
    }
}
