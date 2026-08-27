import Foundation

/// A snapshot of performance metrics at a point in time. Ported verbatim from the
/// reference (frozen wire model): the field set and their JSON keys are part of the
/// contract the TS MCP server decodes, so this stays byte-for-byte identical.
public struct PerformanceSnapshot: Codable, Sendable {
    /// Timestamp in milliseconds (epoch time)
    public let timestamp: Int64

    /// Frames per second (if available)
    public let fps: Float?

    /// Frame time in milliseconds (if available)
    public let frameTimeMs: Float?

    /// Number of janky frames (frames that took longer than expected)
    public let jankFrames: Int?

    /// Touch response latency in milliseconds
    public let touchLatencyMs: Float?

    /// Time to first frame in milliseconds (from app launch)
    public let ttffMs: Float?

    /// Time to interactive in milliseconds
    public let ttiMs: Float?

    /// CPU usage percentage (0-100)
    public let cpuUsagePercent: Float?

    /// Memory usage in MB
    public let memoryUsageMb: Float?

    /// Current screen/view controller name
    public let screenName: String?

    public init(
        timestamp: Int64,
        fps: Float? = nil,
        frameTimeMs: Float? = nil,
        jankFrames: Int? = nil,
        touchLatencyMs: Float? = nil,
        ttffMs: Float? = nil,
        ttiMs: Float? = nil,
        cpuUsagePercent: Float? = nil,
        memoryUsageMb: Float? = nil,
        screenName: String? = nil
    ) {
        self.timestamp = timestamp
        self.fps = fps
        self.frameTimeMs = frameTimeMs
        self.jankFrames = jankFrames
        self.touchLatencyMs = touchLatencyMs
        self.ttffMs = ttffMs
        self.ttiMs = ttiMs
        self.cpuUsagePercent = cpuUsagePercent
        self.memoryUsageMb = memoryUsageMb
        self.screenName = screenName
    }
}
