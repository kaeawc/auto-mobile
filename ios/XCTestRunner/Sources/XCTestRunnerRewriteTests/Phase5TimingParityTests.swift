import Foundation
import XCTest

// Differential parity for the timing-cache pure logic (reference vs rewrite): duplicate-tolerant map
// build (#3618), the request-URI encoding (incl. the `+`→%2B daemon boundary), and summary decode.
@testable import XCTestRunner
@testable import XCTestRunnerRewrite

final class Phase5TimingParityTests: XCTestCase {
    func testBuildTimingMapDeduplicatesKeepingLastParity() {
        let referenceMap = XCTestRunner.TestTimingCache.buildTimingMap(from: [
            referenceEntry(durationMs: 10),
            referenceEntry(durationMs: 20),  // same (class, method) → keep last
        ])
        let rewriteMap = XCTestRunnerRewrite.TestTimingCache.buildTimingMap(from: [
            rewriteEntry(durationMs: 10),
            rewriteEntry(durationMs: 20),
        ])
        XCTAssertEqual(referenceMap.count, 1)
        XCTAssertEqual(rewriteMap.count, referenceMap.count)
        XCTAssertEqual(referenceMap[XCTestRunner.TestTimingKey(testClass: "C", testMethod: "m")]?.averageDurationMs, 20)
        XCTAssertEqual(rewriteMap[XCTestRunnerRewrite.TestTimingKey(testClass: "C", testMethod: "m")]?.averageDurationMs, 20)
    }

    func testBuildRequestUriParity() {
        let cases: [[String: String]] = [
            [:],  // → bare "automobile:test-timings"
            ["minSamples": "1", "devicePlatform": "ios"],
            ["sessionUuid": "abc+def", "limit": "1000"],  // literal + must become %2B
        ]
        for parameters in cases {
            XCTAssertEqual(
                XCTestRunner.TestTimingCache.buildRequestUri(parameters: parameters),
                XCTestRunnerRewrite.TestTimingCache.buildRequestUri(parameters: parameters),
                "params=\(parameters)"
            )
        }
    }

    func testTestTimingSummaryDecodeParity() throws {
        let json = """
        {"testTimings":[{"testClass":"C","testMethod":"m","averageDurationMs":42,"sampleSize":3,
          "successRate":1.0,"statusCounts":{"passed":3,"failed":0,"skipped":0}}],
         "generatedAt":"2026-01-01","totalTests":1,"totalSamples":3}
        """
        let data = Data(json.utf8)
        let reference = try JSONDecoder().decode(XCTestRunner.TestTimingSummary.self, from: data)
        let rewrite = try JSONDecoder().decode(XCTestRunnerRewrite.TestTimingSummary.self, from: data)
        XCTAssertEqual(reference.totalTests, rewrite.totalTests)
        XCTAssertEqual(reference.totalSamples, rewrite.totalSamples)
        XCTAssertEqual(reference.testTimings.count, rewrite.testTimings.count)
        XCTAssertEqual(reference.testTimings.first?.averageDurationMs, rewrite.testTimings.first?.averageDurationMs)
        XCTAssertEqual(reference.testTimings.first?.statusCounts?.passed, rewrite.testTimings.first?.statusCounts?.passed)
    }

    private func referenceEntry(durationMs: Int) -> XCTestRunner.TestTimingEntry {
        XCTestRunner.TestTimingEntry(
            testClass: "C", testMethod: "m", averageDurationMs: durationMs, sampleSize: 1,
            lastRun: nil, lastRunTimestampMs: nil, successRate: nil, failureRate: nil,
            stdDevDurationMs: nil, statusCounts: nil
        )
    }

    private func rewriteEntry(durationMs: Int) -> XCTestRunnerRewrite.TestTimingEntry {
        XCTestRunnerRewrite.TestTimingEntry(
            testClass: "C", testMethod: "m", averageDurationMs: durationMs, sampleSize: 1,
            lastRun: nil, lastRunTimestampMs: nil, successRate: nil, failureRate: nil,
            stdDevDurationMs: nil, statusCounts: nil
        )
    }
}
