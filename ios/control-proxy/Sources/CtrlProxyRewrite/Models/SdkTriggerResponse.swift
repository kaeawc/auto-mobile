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
