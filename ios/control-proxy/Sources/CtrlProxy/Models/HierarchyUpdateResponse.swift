import Foundation

/// Live gesture geometry, using the same corrected rotation as subsequent taps.
public struct RefreshGeometryResponse: Codable, Sendable {
    /// Capture result shared with the locator; the response flattens its fields on the wire.
    public struct Geometry: Sendable {
        let geometry: GestureCoordinateGeometry
        let foregroundBundleId: String?
    }

    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let error: String?
    public let refreshed: Bool
    public let rotation: Int?
    public let appWidth: Double?
    public let appHeight: Double?
    public let screenWidth: Double?
    public let screenHeight: Double?
    public let observationWidth: Double?
    public let observationHeight: Double?
    public let foregroundBundleId: String?
    public let totalTimeMs: Int64

    public init(
        requestId: String?, success: Bool, error: String? = nil,
        geometry: Geometry? = nil, totalTimeMs: Int64
    ) {
        type = ResponseType.refreshGeometryResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.error = error
        refreshed = geometry != nil
        rotation = geometry?.geometry.rotation
        appWidth = geometry?.geometry.app.width
        appHeight = geometry?.geometry.app.height
        screenWidth = geometry?.geometry.screen.width
        screenHeight = geometry?.geometry.screen.height
        observationWidth = geometry?.geometry.observation.width
        observationHeight = geometry?.geometry.observation.height
        foregroundBundleId = geometry?.foregroundBundleId
        self.totalTimeMs = totalTimeMs
    }

    private enum CodingKeys: String, CodingKey {
        case type, timestamp, requestId, success, error, refreshed, rotation
        case appWidth, appHeight, screenWidth, screenHeight, observationWidth, observationHeight
        case foregroundBundleId, totalTimeMs
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encodeIfPresent(requestId, forKey: .requestId)
        try container.encode(success, forKey: .success)
        try container.encodeIfPresent(error, forKey: .error)
        try container.encode(refreshed, forKey: .refreshed)
        try container.encode(rotation, forKey: .rotation)
        try container.encode(appWidth, forKey: .appWidth)
        try container.encode(appHeight, forKey: .appHeight)
        try container.encode(screenWidth, forKey: .screenWidth)
        try container.encode(screenHeight, forKey: .screenHeight)
        try container.encode(observationWidth, forKey: .observationWidth)
        try container.encode(observationHeight, forKey: .observationHeight)
        try container.encode(foregroundBundleId, forKey: .foregroundBundleId)
        try container.encode(totalTimeMs, forKey: .totalTimeMs)
    }
}

/// The `hierarchy_update` push (and `request_hierarchy` result) payload.
public struct HierarchyUpdateResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let data: ViewHierarchy?
    public let perfTiming: PerfTiming?
    public let error: String?
    /// Opaque identity calculated from the exact hierarchy captured on device.
    public let frameContext: String?
    /// True only when data is a previous capture, rather than a new screen extraction.
    public let servedFromCache: Bool?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        requestId: String? = nil,
        data: ViewHierarchy? = nil,
        perfTiming: PerfTiming? = nil,
        error: String? = nil,
        frameContext: String? = nil,
        servedFromCache: Bool? = nil
    ) {
        type = "hierarchy_update"
        self.timestamp = timestamp
        self.requestId = requestId
        self.data = data
        self.perfTiming = perfTiming
        self.error = error
        self.frameContext = frameContext
        self.servedFromCache = servedFromCache
    }

    /// Returns this response with performance timing attached without changing its
    /// original capture timestamp or any other wire field.
    public func withPerfTiming(_ perfTiming: PerfTiming) -> HierarchyUpdateResponse {
        HierarchyUpdateResponse(
            timestamp: timestamp,
            requestId: requestId,
            data: data,
            perfTiming: perfTiming,
            error: error,
            frameContext: frameContext,
            servedFromCache: servedFromCache
        )
    }
}
