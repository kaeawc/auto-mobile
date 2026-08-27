import Foundation

// Module-agnostic fixtures for the performance wire-parity harness. This file imports
// NEITHER module: it defines a spec that `ReferencePerformanceWire` and
// `RewritePerformanceWire` each translate into their module's `PerformanceSnapshot`,
// so the vocabulary never names either module's types.

/// Mirrors `PerformanceSnapshot`'s 10 fields exactly, so a driver can rebuild the
/// snapshot in its own module.
struct PerfSnapshotSpec: Sendable {
    let timestamp: Int64
    let fps: Float?
    let frameTimeMs: Float?
    let jankFrames: Int?
    let touchLatencyMs: Float?
    let ttffMs: Float?
    let ttiMs: Float?
    let cpuUsagePercent: Float?
    let memoryUsageMb: Float?
    let screenName: String?
}

/// Specs exercised by `PerformanceWireParityTests`, each encoded through BOTH modules'
/// models. Together they cover: every field populated, all-optionals-nil (Codable key
/// omission), a realistic mix, JSON string escaping, and an uncapped ProMotion FPS.
enum PerfSnapshotSpecs {
    static let all: [PerfSnapshotSpec] = [full, allNil, mixed, specialString, uncappedFps]

    /// Every field populated with a distinct value.
    static let full = PerfSnapshotSpec(
        timestamp: 1_730_000_000_000, fps: 59.94, frameTimeMs: 16.68, jankFrames: 2,
        touchLatencyMs: 12.5, ttffMs: 120, ttiMs: 350, cpuUsagePercent: 42.5,
        memoryUsageMb: 128.25, screenName: "HomeViewController"
    )

    /// Only the (required) timestamp; every optional nil → Codable omits those keys.
    static let allNil = PerfSnapshotSpec(
        timestamp: 42, fps: nil, frameTimeMs: nil, jankFrames: nil, touchLatencyMs: nil,
        ttffMs: nil, ttiMs: nil, cpuUsagePercent: nil, memoryUsageMb: nil, screenName: nil
    )

    /// A realistic mix of set and nil fields.
    static let mixed = PerfSnapshotSpec(
        timestamp: 999, fps: 60, frameTimeMs: nil, jankFrames: 0, touchLatencyMs: nil,
        ttffMs: nil, ttiMs: nil, cpuUsagePercent: 3.5, memoryUsageMb: nil, screenName: "A/B"
    )

    /// `screenName` with characters that require JSON string escaping.
    static let specialString = PerfSnapshotSpec(
        timestamp: 7, fps: 30, frameTimeMs: 33.33, jankFrames: 5, touchLatencyMs: nil,
        ttffMs: nil, ttiMs: nil, cpuUsagePercent: nil, memoryUsageMb: nil,
        screenName: "quote\" back\\slash \u{1F600} 日本語"
    )

    /// ProMotion: FPS above 60 (verifies the model carries an uncapped value).
    static let uncappedFps = PerfSnapshotSpec(
        timestamp: 1, fps: 120, frameTimeMs: 8.33, jankFrames: 0, touchLatencyMs: nil,
        ttffMs: nil, ttiMs: nil, cpuUsagePercent: nil, memoryUsageMb: nil, screenName: nil
    )
}
