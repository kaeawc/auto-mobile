import CtrlProxy
import Foundation

// REFERENCE side of the performance wire-parity harness. Imports ONLY `CtrlProxy`, so
// `PerformanceSnapshot` / `PerformanceUpdateResponse` resolve to the oracle's models.
// Rebuilds the snapshot from a module-agnostic `PerfSnapshotSpec` and returns the
// sorted-key encoded bytes for the diff in `PerformanceWireParityTests`.
enum ReferencePerformanceWire {
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
