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
    public let text: String?
    public let perfTiming: PerfTiming?
    /// Which mechanism performed a pinch: `"event-path"` (private synthesis, honors
    /// center) or `"element-anchored"` (public fallback, center-less). Only set on
    /// `pinch_result` responses (issue #2910); nil elsewhere.
    public let pinchPath: String?

    public init(
        type: String,
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        requestId: String? = nil,
        success: Bool? = nil,
        totalTimeMs: Int64? = nil,
        error: String? = nil,
        text: String? = nil,
        perfTiming: PerfTiming? = nil,
        pinchPath: String? = nil
    ) {
        self.type = type
        self.timestamp = timestamp
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
        self.error = error
        self.text = text
        self.perfTiming = perfTiming
        self.pinchPath = pinchPath
    }

    public static func success(
        type: String,
        requestId: String?,
        totalTimeMs: Int64,
        text: String? = nil,
        pinchPath: String? = nil
    )
        -> WebSocketResponse
    {
        WebSocketResponse(
            type: type,
            requestId: requestId,
            success: true,
            totalTimeMs: totalTimeMs,
            text: text,
            pinchPath: pinchPath
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
}
