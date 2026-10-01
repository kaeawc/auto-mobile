import Foundation

/// Base response envelope (matching Android AccessibilityService). Encoded with
/// sorted keys onto the wire; `timestamp` is epoch-milliseconds.
public struct WebSocketResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool?
    public let totalTimeMs: Int64?
    public let error: String?
    /// Present only on a runner_busy error response.
    public let blockingCommandType: String?
    public let blockingElapsedMs: Int64?
    /// Signed milliseconds until the blocking command's deadline; negative means overdue.
    public let blockingDeadlineRemainingMs: Int64?
    public let text: String?
    public let perfTiming: PerfTiming?
    /// Present on key results when caret movement was checked or could not be checked.
    public let verified: Bool?
    public let warning: String?
    /// Which mechanism performed a pinch: `"event-path"` (private synthesis, honors
    /// center) or `"element-anchored"` (public fallback, center-less). Only set on
    /// `pinch_result` responses (issue #2910); nil elsewhere.
    public let pinchPath: String?
    public let resolvedStore: String?
    var effectiveValueDiffers: Bool?

    public init(
        type: String,
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        requestId: String? = nil,
        success: Bool? = nil,
        totalTimeMs: Int64? = nil,
        error: String? = nil,
        blockingCommandType: String? = nil,
        blockingElapsedMs: Int64? = nil,
        blockingDeadlineRemainingMs: Int64? = nil,
        text: String? = nil,
        perfTiming: PerfTiming? = nil,
        verified: Bool? = nil,
        warning: String? = nil,
        pinchPath: String? = nil,
        resolvedStore: String? = nil
    ) {
        self.type = type
        self.timestamp = timestamp
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
        self.error = error
        self.blockingCommandType = blockingCommandType
        self.blockingElapsedMs = blockingElapsedMs
        self.blockingDeadlineRemainingMs = blockingDeadlineRemainingMs
        self.text = text
        self.perfTiming = perfTiming
        self.verified = verified
        self.warning = warning
        self.pinchPath = pinchPath
        self.resolvedStore = resolvedStore
    }

    public static func success(
        type: String,
        requestId: String?,
        totalTimeMs: Int64,
        text: String? = nil,
        pinchPath: String? = nil,
        resolvedStore: String? = nil
    )
        -> WebSocketResponse
    {
        WebSocketResponse(
            type: type,
            requestId: requestId,
            success: true,
            totalTimeMs: totalTimeMs,
            text: text,
            pinchPath: pinchPath,
            resolvedStore: resolvedStore
        )
    }

    public static func error(
        type: String,
        requestId: String?,
        error: String,
        totalTimeMs: Int64? = nil
    )
        -> WebSocketResponse
    {
        WebSocketResponse(
            type: type,
            requestId: requestId,
            success: false,
            totalTimeMs: totalTimeMs,
            error: error
        )
    }

    /// Returns this response with performance timing attached while preserving every
    /// other wire field. An existing total time takes precedence over the fallback.
    public func withPerfTiming(_ perfTiming: PerfTiming, totalTimeMs fallbackTotalTimeMs: Int64) -> WebSocketResponse {
        var response = WebSocketResponse(
            type: type,
            timestamp: timestamp,
            requestId: requestId,
            success: success,
            totalTimeMs: totalTimeMs ?? fallbackTotalTimeMs,
            error: error,
            blockingCommandType: blockingCommandType,
            blockingElapsedMs: blockingElapsedMs,
            blockingDeadlineRemainingMs: blockingDeadlineRemainingMs,
            text: text,
            perfTiming: perfTiming,
            verified: verified,
            warning: warning,
            pinchPath: pinchPath,
            resolvedStore: resolvedStore
        )
        response.effectiveValueDiffers = effectiveValueDiffers
        return response
    }
}
