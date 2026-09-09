import Foundation

/// Push notification for performance metrics (FPS, frame time, etc.). Ported verbatim
/// from the reference (frozen wire model). `type`/`timestamp`/`performanceData` and
/// their default JSON keys match the reference byte-for-byte; `timestamp` is stamped
/// from a live `Date()` at init, so parity comparisons strip it (see the response
/// parity suite).
///
/// The reference declared this `Codable` only; the rewrite adds `Sendable` (all fields
/// already are) to match the house rule that wire models are `Codable & Sendable`. It
/// does not change the encoded bytes.
public struct PerformanceUpdateResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let performanceData: PerformanceSnapshot

    public init(data: PerformanceSnapshot) {
        type = "performance_update"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        performanceData = data
    }
}
