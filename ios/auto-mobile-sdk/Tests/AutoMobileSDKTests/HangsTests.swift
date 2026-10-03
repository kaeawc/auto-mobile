@testable import AutoMobileSDK
import XCTest

final class HangsTests: XCTestCase {
    func testHangThresholdRejectsNonFiniteAndNegativeValues() {
        let hangs = AutoMobileHangs.makeTestInstance()

        for value in [Double.nan, .infinity, -.infinity, -5] {
            hangs.hangThresholdMs = value
            XCTAssertEqual(hangs.hangThresholdMs, 2000)
        }
    }

    func testHangThresholdPreservesValidValuesIncludingZero() {
        let hangs = AutoMobileHangs.makeTestInstance()

        hangs.hangThresholdMs = 1234
        XCTAssertEqual(hangs.hangThresholdMs, 1234)
        hangs.hangThresholdMs = 0
        XCTAssertEqual(hangs.hangThresholdMs, 0)
    }

    func testPollIntervalRejectsNonFiniteAndNonPositiveValues() {
        let hangs = AutoMobileHangs.makeTestInstance()

        for value in [Double.nan, .infinity, -.infinity, -5, 0] {
            hangs.pollIntervalMs = value
            XCTAssertEqual(hangs.pollIntervalMs, 500)
        }
    }

    func testPollIntervalPreservesValidValues() {
        let hangs = AutoMobileHangs.makeTestInstance()

        hangs.pollIntervalMs = 1234
        XCTAssertEqual(hangs.pollIntervalMs, 1234)
    }

    /// A responsive main thread (probe succeeds within threshold) reports no hang.
    func testResponsiveThreadReportsNoHang() {
        let hangs = AutoMobileHangs.makeTestInstance()
        var probeCalls = 0
        hangs.probeMainThread = { _ in probeCalls += 1; return true }

        let duration = hangs.runWatchdogCycle(shouldContinue: { true })

        XCTAssertNil(duration)
        XCTAssertEqual(probeCalls, 1)
    }

    /// A sustained hang across several probes yields exactly ONE report whose
    /// duration spans first detection to recovery — not one report per poll each
    /// mis-reporting ~hangThresholdMs (the #3622 regression).
    func testSustainedHangReportsOnceWithFullDuration() {
        let hangs = AutoMobileHangs.makeTestInstance()

        // Monotonic clock advances 1000ms per read. probeStart reads once, the
        // recovery report reads once → duration is deterministic regardless of
        // how many probes the hang spans.
        var clock = 0.0
        hangs.monotonicNowMs = { let v = clock; clock += 1000; return v }

        // hung, hung, hung, then recovered.
        let results = [false, false, false, true]
        var idx = 0
        var probeCalls = 0
        hangs.probeMainThread = { _ in
            probeCalls += 1
            defer { idx += 1 }
            return results[idx]
        }

        let duration = hangs.runWatchdogCycle(shouldContinue: { true })

        XCTAssertEqual(duration, 1000) // single event spanning the whole hang
        XCTAssertEqual(probeCalls, 4) // 1 detection probe + 3 recovery probes
    }

    /// If monitoring stops (or the app is being torn down) before the thread
    /// recovers, no hang event is emitted.
    func testHangWithoutRecoveryReportsNothingWhenMonitoringStops() {
        let hangs = AutoMobileHangs.makeTestInstance()
        hangs.probeMainThread = { _ in false } // never recovers
        var remaining = 3
        let duration = hangs.runWatchdogCycle(shouldContinue: {
            remaining -= 1
            return remaining > 0
        })
        XCTAssertNil(duration)
    }

    /// Threshold/poll accessors are lock-guarded; concurrent read/write must not
    /// crash (they were unsynchronized `public var`s read on the watchdog thread).
    func testThresholdAccessorsAreThreadSafe() {
        let hangs = AutoMobileHangs.makeTestInstance()
        DispatchQueue.concurrentPerform(iterations: 1000) { i in
            hangs.hangThresholdMs = Double(i)
            _ = hangs.hangThresholdMs
            hangs.pollIntervalMs = Double(i)
            _ = hangs.pollIntervalMs
        }
        XCTAssertGreaterThanOrEqual(hangs.hangThresholdMs, 0)
    }
}
