@testable import CtrlProxyRewrite
import XCTest

// Anchored unit tests for `DisplayLinkFPSMonitor`. The reference computed its frame
// math inline in the private, iOS-only `CADisplayLink` callback, so it had no host
// coverage; the rewrite extracted `frameMetrics(frameTimesMs:)` to make it testable
// off-device. `CADisplayLink` itself only exists on iOS (verified at Phase 7 in Xcode),
// so these tests cover the deterministic math + the host-observable lifecycle.
@MainActor
final class DisplayLinkFPSMonitorTests: XCTestCase {
    // MARK: - frameMetrics (pure math)

    func testFrameMetricsNilWhenNoFrames() {
        XCTAssertNil(DisplayLinkFPSMonitor.frameMetrics(frameTimesMs: []))
    }

    func testFrameMetricsSingleFrame() throws {
        let metrics = try XCTUnwrap(DisplayLinkFPSMonitor.frameMetrics(frameTimesMs: [16.0]))
        XCTAssertEqual(metrics.frameTimeMs, 16.0, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(metrics.fps), 62.5, accuracy: 0.0001) // 1000 / 16
    }

    func testFrameMetricsAveragesIntervals() throws {
        let metrics = try XCTUnwrap(DisplayLinkFPSMonitor.frameMetrics(frameTimesMs: [10, 20, 30]))
        XCTAssertEqual(metrics.frameTimeMs, 20.0, accuracy: 0.0001) // mean of the intervals
        XCTAssertEqual(try XCTUnwrap(metrics.fps), 50.0, accuracy: 0.0001) // 1000 / 20
    }

    func testFrameMetricsFpsUncappedForProMotion() throws {
        // ~8.33ms ≈ 120Hz: FPS must exceed 60, proving the value is not clamped.
        let metrics = try XCTUnwrap(DisplayLinkFPSMonitor.frameMetrics(frameTimesMs: [8.33]))
        XCTAssertGreaterThan(try XCTUnwrap(metrics.fps), 100)
    }

    // MARK: - lifecycle

    func testCollectMetricsNilBeforeAnyFrames() async {
        let monitor = DisplayLinkFPSMonitor(timeProvider: FakeTimeProvider(initialTime: 1000))
        let snapshot = await monitor.collectMetrics()
        XCTAssertNil(snapshot, "no frames sampled yet → nil snapshot")
    }

    func testIsMonitoringTogglesAndStartIsIdempotent() {
        let monitor = DisplayLinkFPSMonitor()
        XCTAssertFalse(monitor.isMonitoring)

        monitor.startMonitoring { _ in }
        XCTAssertTrue(monitor.isMonitoring)

        monitor.startMonitoring { _ in } // second start is a no-op, must not crash
        XCTAssertTrue(monitor.isMonitoring)

        monitor.stopMonitoring()
        XCTAssertFalse(monitor.isMonitoring)
    }

    // MARK: - system metrics (non-deterministic; assert reachable + in range)

    func testSystemMetricsAreReadable() {
        let memory = DisplayLinkFPSMonitor.collectMemoryUsageMb()
        XCTAssertNotNil(memory, "resident memory should always be readable for the running process")
        if let memory {
            XCTAssertGreaterThan(memory, 0)
        }

        // CPU may legitimately read 0 when idle; only require a value within [0, 100].
        if let cpu = DisplayLinkFPSMonitor.collectCpuUsagePercent() {
            XCTAssertGreaterThanOrEqual(cpu, 0)
            XCTAssertLessThanOrEqual(cpu, 100)
        }
    }
}
