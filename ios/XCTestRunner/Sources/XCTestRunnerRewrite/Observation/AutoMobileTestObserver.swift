import Foundation
import os
import XCTest

/// XCTestObservation integration for collecting timing data and test results.
///
/// Concurrency: XCTestObservation callbacks arrive on parallel XCTest worker threads (NOT the main
/// thread), so this is `nonisolated` — NOT `@MainActor`. All mutable state is lock-confined
/// (`OSAllocatedUnfairLock`, replacing the reference's two `NSLock`s and its mutable `static var`):
/// the shared-observer registration and the per-observer timing state each live behind a lock, keeping
/// the single locked write path (issue #3629). `@unchecked Sendable` because it is a non-final NSObject
/// subclass; all mutable state is behind the locks.
public class AutoMobileTestObserver: NSObject, XCTestObservation, @unchecked Sendable {
    /// Timing data for test cases
    public struct TimingData: Sendable {
        public let testName: String
        public let duration: TimeInterval
        public let startTime: Date
        public let endTime: Date
        public let passed: Bool
    }

    private struct TimingState: Sendable {
        var timingData: [TimingData] = []
        var testStartTimes: [ObjectIdentifier: Date] = [:]
    }

    private static let registration = OSAllocatedUnfairLock<AutoMobileTestObserver?>(initialState: nil)
    private let timing = OSAllocatedUnfairLock<TimingState>(initialState: TimingState())

    /// Register this observer with the test observation center
    public static func register() -> AutoMobileTestObserver {
        return registerIfNeeded()
    }

    public static func registerIfNeeded() -> AutoMobileTestObserver {
        return registration.withLock { existing in
            if let existing = existing {
                return existing
            }
            let observer = AutoMobileTestObserver()
            XCTestObservationCenter.shared.addTestObserver(observer)
            existing = observer
            return observer
        }
    }

    /// Called when a test case starts
    public func testCaseWillStart(_ testCase: XCTestCase) {
        // Derive the Sendable key/timestamp outside the (Sendable) withLock body — a non-Sendable
        // `XCTestCase` cannot be captured into it.
        let key = ObjectIdentifier(testCase)
        let startTime = Date()
        timing.withLock { $0.testStartTimes[key] = startTime }
        print("Test case starting: \(testCase.name)")
    }

    /// Called when a test case finishes
    public func testCaseDidFinish(_ testCase: XCTestCase) {
        let key = ObjectIdentifier(testCase)
        guard let startTime = timing.withLock({ $0.testStartTimes.removeValue(forKey: key) }) else {
            return
        }

        let endTime = Date()
        let duration = endTime.timeIntervalSince(startTime)

        let timingData = TimingData(
            testName: testCase.name,
            duration: duration,
            startTime: startTime,
            endTime: endTime,
            passed: testCase.testRun?.totalFailureCount == 0
        )

        recordTiming(timingData)

        print("Test case finished: \(testCase.name) - Duration: \(duration)s - Passed: \(timingData.passed)")
    }

    /// Append a timing entry under the lock. Single write path so all mutations
    /// of `timingData` stay synchronized (issue #3629).
    func recordTiming(_ timing: TimingData) {
        self.timing.withLock { $0.timingData.append(timing) }
    }

    /// Called when a test suite starts
    public func testSuiteWillStart(_ testSuite: XCTestSuite) {
        print("Test suite starting: \(testSuite.name)")
    }

    /// Called when a test suite finishes
    public func testSuiteDidFinish(_ testSuite: XCTestSuite) {
        print("Test suite finished: \(testSuite.name)")
        printSummary()
    }

    /// Gets all collected timing data
    public func getTimingData() -> [TimingData] {
        return timing.withLock { $0.timingData }
    }

    /// Exports timing data to JSON
    public func exportTimingData(to path: String) throws {
        // Snapshot under the lock; testCaseDidFinish may append concurrently under
        // parallel testing (issue #3629).
        let data = getTimingData()
        let jsonData = try JSONEncoder().encode(data)
        try jsonData.write(to: URL(fileURLWithPath: path))
    }

    /// Prints a summary of timing data
    private func printSummary() {
        // Snapshot under the lock before reading repeatedly (issue #3629).
        let data = getTimingData()
        guard !data.isEmpty else {
            return
        }

        print("\n=== Test Timing Summary ===")
        print("Total tests: \(data.count)")
        print("Passed: \(data.filter { $0.passed }.count)")
        print("Failed: \(data.filter { !$0.passed }.count)")

        let totalDuration = data.reduce(0) { $0 + $1.duration }
        print("Total duration: \(String(format: "%.2f", totalDuration))s")

        if let slowest = data.max(by: { $0.duration < $1.duration }) {
            print("Slowest test: \(slowest.testName) (\(String(format: "%.2f", slowest.duration))s)")
        }

        if let fastest = data.min(by: { $0.duration < $1.duration }) {
            print("Fastest test: \(fastest.testName) (\(String(format: "%.2f", fastest.duration))s)")
        }

        print("===========================\n")
    }
}

/// Make TimingData Encodable for JSON export. Frozen export shape: `testName, duration, startTime,
/// endTime, passed` with ISO8601 timestamps.
extension AutoMobileTestObserver.TimingData: Encodable {
    enum CodingKeys: String, CodingKey {
        case testName, duration, startTime, endTime, passed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(testName, forKey: .testName)
        try container.encode(duration, forKey: .duration)
        try container.encode(ISO8601DateFormatter().string(from: startTime), forKey: .startTime)
        try container.encode(ISO8601DateFormatter().string(from: endTime), forKey: .endTime)
        try container.encode(passed, forKey: .passed)
    }
}
