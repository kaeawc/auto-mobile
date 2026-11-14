import Foundation

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
