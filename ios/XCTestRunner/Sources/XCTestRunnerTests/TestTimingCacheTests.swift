import XCTest
@testable import XCTestRunner

final class TestTimingCacheTests: XCTestCase {
    private func entry(_ cls: String, _ method: String, avg: Int) -> TestTimingEntry {
        TestTimingEntry(
            testClass: cls,
            testMethod: method,
            averageDurationMs: avg,
            sampleSize: 1,
            lastRun: nil,
            lastRunTimestampMs: nil,
            successRate: nil,
            failureRate: nil,
            stdDevDurationMs: nil,
            statusCounts: nil
        )
    }

    func testBuildTimingMapUniqueEntries() {
        let map = TestTimingCache.buildTimingMap(from: [
            entry("SuiteA", "testFoo", avg: 10),
            entry("SuiteA", "testBar", avg: 20),
            entry("SuiteB", "testFoo", avg: 30),
        ])
        XCTAssertEqual(map.count, 3)
        XCTAssertEqual(map[TestTimingKey(testClass: "SuiteA", testMethod: "testFoo")]?.averageDurationMs, 10)
        XCTAssertEqual(map[TestTimingKey(testClass: "SuiteB", testMethod: "testFoo")]?.averageDurationMs, 30)
    }

    /// A duplicate (class, method) row must NOT crash the process. Pre-fix this
    /// went through `Dictionary(uniqueKeysWithValues:)`, which `fatalError`s on a
    /// duplicate key — an uncatchable trap that took down the whole test run
    /// (issue #3618). The dedup keeps the last occurrence.
    func testBuildTimingMapToleratesDuplicateKeysKeepingLast() {
        let map = TestTimingCache.buildTimingMap(from: [
            entry("SuiteA", "testFoo", avg: 10),
            entry("SuiteA", "testFoo", avg: 99), // duplicate key
            entry("SuiteA", "testBar", avg: 20),
        ])
        XCTAssertEqual(map.count, 2)
        XCTAssertEqual(map[TestTimingKey(testClass: "SuiteA", testMethod: "testFoo")]?.averageDurationMs, 99)
        XCTAssertEqual(map[TestTimingKey(testClass: "SuiteA", testMethod: "testBar")]?.averageDurationMs, 20)
    }

    func testBuildTimingMapEmpty() {
        XCTAssertTrue(TestTimingCache.buildTimingMap(from: []).isEmpty)
    }

    func testBuildRequestUriKeepsQueryValueAsSingleItem() throws {
        let sessionUuid = "session+plus&unexpected=value space 🐶"
        let uri = TestTimingCache.buildRequestUri(parameters: [
            "devicePlatform": "ios",
            "sessionUuid": sessionUuid,
        ])
        let components = try XCTUnwrap(URLComponents(string: uri))
        let queryItems = try XCTUnwrap(components.queryItems)

        XCTAssertEqual(components.scheme, "automobile")
        XCTAssertEqual(components.path, "test-timings")
        XCTAssertEqual(queryItems.count, 2)
        XCTAssertEqual(queryItems.first(where: { $0.name == "sessionUuid" })?.value, sessionUuid)
        XCTAssertTrue(uri.contains("sessionUuid=session%2Bplus"))
        XCTAssertFalse(uri.contains("sessionUuid=session+plus&unexpected=value"))
    }

    func testBuildRequestUriWithoutParametersUsesBaseResourceUri() {
        XCTAssertEqual(TestTimingCache.buildRequestUri(parameters: [:]), "automobile:test-timings")
    }
}
