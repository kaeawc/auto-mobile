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

    public init(
        requestId: String? = nil,
        data: ViewHierarchy? = nil,
        perfTiming: PerfTiming? = nil,
        error: String? = nil,
        frameContext: String? = nil
    ) {
        type = "hierarchy_update"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.data = data
        self.perfTiming = perfTiming
        self.error = error
        self.frameContext = frameContext
    }
}
