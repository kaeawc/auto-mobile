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
    /// No SDK in the foreground app, no registered bridge, or the SDK did not answer.
    case bridgeUnavailable = "bridge_unavailable"
    /// The app resigned active before the SDK could serve the request.
    case appNotActive = "app_not_active"
    /// `actionJson` is missing or is not an `AutoMobileAction`.
    case invalidAction = "invalid_action"
    /// The SDK answered with a status or body this runner does not understand.
    case badReply = "bad_reply"

    var message: String {
        switch self {
        case .bridgeUnavailable:
            "The foreground app has no AutoMobile SDK observation bridge registered, or the SDK did not answer."
        case .appNotActive: "The foreground app resigned active before the SDK could serve the request."
        case .invalidAction: "actionJson must be one JSON-encoded AutoMobileAction."
        case .badReply: "The in-app SDK returned a reply this runner could not decode."
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
