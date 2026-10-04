import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class TimeoutSaturationTests: XCTestCase {
    func testExcessiveTimeoutsClampTo24Hours() {
        let values: [TimeInterval] = [
            Double.infinity,
            1e300,
            Double.greatestFiniteMagnitude,
            24 * 3600 + 1,
        ]
        for seconds in values {
            XCTAssertEqual(TimeoutConversion.clampedSeconds(seconds), TimeoutConversion.maximumSeconds)
            XCTAssertEqual(TimeoutConversion.milliseconds(forSeconds: seconds), 86_400_000)
        }
    }

    func testInvalidAndNonPositiveTimeoutsBecomeZero() {
        let values: [TimeInterval] = [-Double.infinity, -1.0, -0.0, 0.0, Double.nan]
        for seconds in values {
            XCTAssertEqual(TimeoutConversion.clampedSeconds(seconds), 0)
            XCTAssertEqual(TimeoutConversion.milliseconds(forSeconds: seconds), 0)
        }
    }

    func testOrdinaryTimeoutsPreserveSecondsAndTruncateMilliseconds() {
        let cases: [(TimeInterval, Int)] = [
            (1.5, 1500),
            (300.0, 300_000),
            (86400.0, 86_400_000),
            (0.0004, 0),
        ]
        for (seconds, milliseconds) in cases {
            XCTAssertEqual(TimeoutConversion.clampedSeconds(seconds), seconds)
            XCTAssertEqual(TimeoutConversion.milliseconds(forSeconds: seconds), milliseconds)
        }
    }

    func testEnvironmentRejectsNonFiniteValues() {
        let values: [String] = ["inf", "-inf", "nan", "infinity", "1e999"]
        for value in values {
            XCTAssertNil(AutoMobileEnvironment(values: ["X": value]).doubleValue(["X"]))
        }
    }

    func testEnvironmentPreservesFiniteValuesIncludingNegatives() {
        let cases: [(String, Double)] = [("30", 30.0), ("0.25", 0.25), ("-5", -5.0)]
        for (value, expected) in cases {
            XCTAssertEqual(AutoMobileEnvironment(values: ["X": value]).doubleValue(["X"]), expected)
        }
    }

    func testEnvironmentUsesOnlyFirstNonEmptyKey() {
        XCTAssertNil(AutoMobileEnvironment(values: ["B": "inf"]).doubleValue(["A", "B"]))
        XCTAssertNil(AutoMobileEnvironment(values: ["A": "inf", "B": "7"]).doubleValue(["A", "B"]))
        XCTAssertEqual(AutoMobileEnvironment(values: ["B": "7"]).doubleValue(["A", "B"]), 7)
        XCTAssertNil(AutoMobileEnvironment(values: [:]).doubleValue(["X"]))
    }

    func testInfiniteSystemDeadlineSleepCancelsWithoutTrapping() async {
        let task = Task { try await SystemDeadlineScheduler().sleep(seconds: .infinity) }
        task.cancel()
        await assertTransportCancellation(task)
    }
}
