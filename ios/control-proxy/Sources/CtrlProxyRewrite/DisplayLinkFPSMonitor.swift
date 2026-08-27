import Foundation
import QuartzCore

#if canImport(UIKit) && os(iOS)
    import UIKit
#endif

/// FPS monitor that uses `CADisplayLink` to measure actual frame delivery timing.
///
/// Based on Apple's recommended patterns from WWDC and documentation:
/// - Uses `link.timestamp` for actual frame timing (not `CACurrentMediaTime`)
/// - Measures actual intervals between callbacks to determine real FPS
/// - Detects jank when frame time exceeds budget (16.67ms for 60Hz, 8.33ms for 120Hz)
///
/// Note: For ProMotion (120Hz) on iPhone, the app's Info.plist must include:
///   `<key>CADisableMinimumFrameDurationOnPhone</key><true/>`
///
/// Rewrite archetype: **`@MainActor`**. The reference was a plain `class` guarding
/// every field with an `NSLock`; `CADisplayLink` is added to the main run loop and
/// fires its target on the main thread, so the rewrite isolates the whole monitor to
/// the main actor and drops the lock. This also closes the **DisplayLink-orphan race**
/// (race ledger): the link's lifecycle is now owned by main-actor state, so a stale
/// link cannot fire concurrently with teardown.
///
/// Because `startMonitoring` is now main-actor-isolated, the link is created inline
/// rather than via the reference's `DispatchQueue.main.async` hop (which existed only
/// to reach the main thread from a non-isolated caller) — same effect, no async
/// reordering.
///
/// Surface trimmed (YAGNI): the reference's `PerformanceMetricsProvider` protocol had a
/// single conformer (this type; the coordinator holds the concrete monitor) and no
/// injection site, and `NoOpPerformanceMetricsProvider` / `FakePerformanceMetricsProvider`
/// were entirely dead — all three are dropped. The deterministic frame-timing math is
/// extracted into `frameMetrics(frameTimesMs:)` so it can be unit-tested off-device
/// (the reference computed it inline in the private, iOS-only display-link path, so it
/// had no host coverage).
@MainActor
final class DisplayLinkFPSMonitor {
    /// How often to report aggregated metrics (in seconds). Raised from 0.5 to 1.0
    /// (issue #5477): each report enumerates all process threads for CPU and reads
    /// task memory, so halving the report cadence halves that per-report sampling
    /// cost while a client is connected.
    static let defaultReportIntervalSeconds = 1.0

    /// Frame time thresholds for jank detection
    /// - 60Hz budget: 16.67ms
    /// - 120Hz budget: 8.33ms
    /// We use 2x the 60Hz budget as the jank threshold (33.33ms = definitely dropped frames)
    static let defaultJankThresholdMs = 33.33

    #if canImport(UIKit) && os(iOS)
        private var displayLink: CADisplayLink?
    #endif
    private var monitoringCallback: (@Sendable (PerformanceSnapshot) -> Void)?
    private var isMonitoringState = false

    // Frame timing tracking using CADisplayLink timestamps.
    private var lastLinkTimestamp: CFTimeInterval = 0
    private var frameTimesMs: [Double] = []
    private var jankFrameCount = 0
    private var lastReportTime: CFTimeInterval = 0

    /// Report interval in seconds.
    private let reportInterval: Double

    /// Jank threshold in milliseconds. Frames taking longer than this are considered
    /// janky (dropped frames).
    private let jankThresholdMs: Double

    /// Time provider for timestamps in snapshots.
    private let timeProvider: any TimeProvider

    init(
        reportInterval: Double = defaultReportIntervalSeconds,
        jankThresholdMs: Double = defaultJankThresholdMs,
        timeProvider: any TimeProvider = SystemTimeProvider()
    ) {
        self.reportInterval = reportInterval
        self.jankThresholdMs = jankThresholdMs
        self.timeProvider = timeProvider
    }

    func collectMetrics() async -> PerformanceSnapshot? {
        createSnapshot()
    }

    func startMonitoring(callback: @escaping @Sendable (PerformanceSnapshot) -> Void) {
        guard !isMonitoringState else { return }

        isMonitoringState = true
        monitoringCallback = callback
        resetMetrics()

        #if canImport(UIKit) && os(iOS)
            // Already on the main actor, so create the link directly (the reference
            // hopped via DispatchQueue.main.async only to reach the main thread from a
            // non-isolated caller).
            let link = CADisplayLink(target: self, selector: #selector(displayLinkFired))
            // Use .common mode so callbacks continue during scrolling/gestures.
            link.add(to: .main, forMode: .common)
            displayLink = link
            lastLinkTimestamp = 0 // Will be set on first callback.
            lastReportTime = CACurrentMediaTime()
            print("[DisplayLinkFPSMonitor] Started monitoring")
        #else
            print("[DisplayLinkFPSMonitor] CADisplayLink not available on this platform")
        #endif
    }

    func stopMonitoring() {
        isMonitoringState = false
        monitoringCallback = nil

        #if canImport(UIKit) && os(iOS)
            displayLink?.invalidate()
            displayLink = nil
        #endif

        print("[DisplayLinkFPSMonitor] Stopped monitoring")
    }

    var isMonitoring: Bool {
        isMonitoringState
    }

    // MARK: - Display Link Callback

    #if canImport(UIKit) && os(iOS)
        @objc
        private func displayLinkFired(_ link: CADisplayLink) {
            // Use link.timestamp - the time when the frame will be displayed. This is
            // the proper way to measure actual frame intervals.
            let currentTimestamp = link.timestamp

            if lastLinkTimestamp > 0 {
                let frameDuration = currentTimestamp - lastLinkTimestamp
                if frameDuration > 0 {
                    let frameTimeMs = frameDuration * 1000.0
                    frameTimesMs.append(frameTimeMs)
                    // A frame taking >33ms means we missed at least one vsync at 60Hz.
                    if frameTimeMs > jankThresholdMs {
                        jankFrameCount += 1
                    }
                }
            }

            lastLinkTimestamp = currentTimestamp

            let currentTime = CACurrentMediaTime()
            if currentTime - lastReportTime >= reportInterval {
                let snapshot = createSnapshot()
                let callback = monitoringCallback
                resetMetrics()
                lastReportTime = currentTime
                if let snapshot {
                    callback?(snapshot)
                }
            }
        }
    #endif

    // MARK: - Metrics Calculation

    /// Create a snapshot from current accumulated metrics, or `nil` if no frames have
    /// been sampled yet.
    private func createSnapshot() -> PerformanceSnapshot? {
        guard let metrics = Self.frameMetrics(frameTimesMs: frameTimesMs) else { return nil }

        return PerformanceSnapshot(
            timestamp: timeProvider.currentTimeMillis(),
            fps: metrics.fps,
            frameTimeMs: metrics.frameTimeMs,
            jankFrames: jankFrameCount,
            touchLatencyMs: nil, // Would need touch event tracking.
            ttffMs: nil,
            ttiMs: nil,
            cpuUsagePercent: Self.collectCpuUsagePercent(),
            memoryUsageMb: Self.collectMemoryUsageMb(),
            screenName: nil
        )
    }

    /// Reset metrics for the next reporting interval.
    private func resetMetrics() {
        frameTimesMs.removeAll(keepingCapacity: true)
        jankFrameCount = 0
    }

    /// Pure frame-timing math: average frame time (ms) and the derived FPS. Returns
    /// `nil` when no frames have been sampled (mirrors the reference's `frameCount > 0`
    /// guard; `frameTimesMs` gains exactly one entry per counted frame). FPS is left
    /// `nil` if the average is non-positive. FPS is intentionally uncapped — ProMotion
    /// devices reach 120Hz.
    nonisolated static func frameMetrics(frameTimesMs: [Double]) -> (fps: Float?, frameTimeMs: Float)? {
        guard !frameTimesMs.isEmpty else { return nil }
        let avgFrameTimeMs = frameTimesMs.reduce(0, +) / Double(frameTimesMs.count)
        let fps: Float? = avgFrameTimeMs > 0 ? Float(1000.0 / avgFrameTimeMs) : nil
        return (fps: fps, frameTimeMs: Float(avgFrameTimeMs))
    }
}

// MARK: - System Metrics Collection

extension DisplayLinkFPSMonitor {
    /// Collect memory usage using `task_info`. Returns memory in MB or `nil` if
    /// unavailable.
    nonisolated static func collectMemoryUsageMb() -> Float? {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4

        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }

        guard result == KERN_SUCCESS else { return nil }

        // Convert bytes to MB.
        return Float(info.resident_size) / (1024 * 1024)
    }

    /// Collect CPU usage percentage. This is approximate and based on thread CPU time.
    nonisolated static func collectCpuUsagePercent() -> Float? {
        var threadList: thread_act_array_t?
        var threadCount = mach_msg_type_number_t(0)

        let result = task_threads(mach_task_self_, &threadList, &threadCount)
        guard result == KERN_SUCCESS, let threads = threadList else { return nil }

        defer {
            vm_deallocate(
                mach_task_self_,
                vm_address_t(bitPattern: threads),
                vm_size_t(Int(threadCount) * MemoryLayout<thread_t>.stride)
            )
        }

        var totalCpu: Double = 0

        for i in 0 ..< Int(threadCount) {
            var threadInfo = thread_basic_info()
            var threadInfoCount = mach_msg_type_number_t(THREAD_INFO_MAX)

            let infoResult = withUnsafeMutablePointer(to: &threadInfo) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(threadInfoCount)) {
                    thread_info(threads[i], thread_flavor_t(THREAD_BASIC_INFO), $0, &threadInfoCount)
                }
            }

            if infoResult == KERN_SUCCESS && threadInfo.flags & TH_FLAGS_IDLE == 0 {
                totalCpu += Double(threadInfo.cpu_usage) / Double(TH_USAGE_SCALE) * 100.0
            }
        }

        return Float(min(totalCpu, 100.0))
    }
}
