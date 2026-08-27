@testable import CtrlProxyRewrite
import Foundation

// REWRITE side of the performance wire-parity harness. Imports ONLY `CtrlProxyRewrite`,
// so `PerformanceSnapshot` / `PerformanceUpdateResponse` resolve to the rewrite's models.
// Mirrors `ReferencePerformanceWire` field-for-field; the diff in
// `PerformanceWireParityTests` proves the two encodings agree.
enum RewritePerformanceWire {
    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func snapshot(_ spec: PerfSnapshotSpec) -> PerformanceSnapshot {
        PerformanceSnapshot(
            timestamp: spec.timestamp,
            fps: spec.fps,
            frameTimeMs: spec.frameTimeMs,
            jankFrames: spec.jankFrames,
            touchLatencyMs: spec.touchLatencyMs,
            ttffMs: spec.ttffMs,
            ttiMs: spec.ttiMs,
            cpuUsagePercent: spec.cpuUsagePercent,
            memoryUsageMb: spec.memoryUsageMb,
            screenName: spec.screenName
        )
    }

    static func encodeSnapshot(_ spec: PerfSnapshotSpec) throws -> Data {
        try encoder().encode(snapshot(spec))
    }

    static func encodeUpdate(_ spec: PerfSnapshotSpec) throws -> Data {
        try encoder().encode(PerformanceUpdateResponse(data: snapshot(spec)))
    }
}
