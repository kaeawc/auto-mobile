import Foundation
import os
import XCTest
@testable import XCTestRunner

final class TestTimingCacheTests: XCTestCase {
    /// Plain synchronous XCTest threads exercise the sole blocking site; no daemon or timers.
    func testColdCacheFetchReturnsTimingsAndUsesExplicitFilterOnce() throws {
        let data = try JSONEncoder().encode(TestTimingSummary(
            testTimings: [entry("SuiteA", "testFoo", avg: 10)], totalTests: 1, totalSamples: 1
        ))
        let payload = try XCTUnwrap(String(data: data, encoding: .utf8))
        let source = TimingFetchProbe(payload: payload)
        let cache = TestTimingCache(fetcher: { uri, timeout in try await source.fetch(uri, timeout: timeout) })
        XCTAssertNil(cache.getTiming(testClass: "SuiteA", testMethod: "testFoo"))
        XCTAssertEqual(source.calls.count, 0, "cached reads must never block or start I/O")

        XCTAssertTrue(cache.hasTimings(sessionUuid: "prefetch+filter"))
        XCTAssertTrue(cache.hasTimings(sessionUuid: "unused-second-filter"))
        XCTAssertEqual(cache.getTiming(testClass: "SuiteA", testMethod: "testFoo")?.averageDurationMs, 10)
        XCTAssertEqual(cache.getSummary()?.totalTests, 1)
        let call = try XCTUnwrap(source.calls.first)
        let items = try XCTUnwrap(URLComponents(string: call.uri)?.queryItems)
        XCTAssertEqual(items.first(where: { $0.name == "sessionUuid" })?.value, "prefetch+filter")
        XCTAssertEqual(items.first(where: { $0.name == "devicePlatform" })?.value, "ios")
        XCTAssertEqual(call.timeout, 5)
        XCTAssertEqual(source.calls.count, 1)
    }

    func testFailedTimingFetchIsBestEffortAndLeavesCacheEmpty() {
        let source = TimingFetchProbe(failure: .requestFailed("fake timing source failed"))
        let cache = TestTimingCache(fetcher: { uri, timeout in try await source.fetch(uri, timeout: timeout) })
        XCTAssertFalse(cache.hasTimings(sessionUuid: "prefetch-filter"))
        XCTAssertFalse(cache.hasTimings(sessionUuid: "another-filter"))
        XCTAssertNil(cache.getTiming(testClass: "SuiteA", testMethod: "testFoo"))
        XCTAssertNil(cache.getSummary())
        XCTAssertEqual(source.calls.count, 1)
    }

    func testDisabledTimingCacheDoesNotFetch() {
        let source = TimingFetchProbe()
        let cache = TestTimingCache(
            fetcher: { uri, timeout in try await source.fetch(uri, timeout: timeout) }, enabled: { false }
        )
        XCTAssertFalse(cache.hasTimings(sessionUuid: "prefetch-filter"))
        XCTAssertTrue(source.calls.isEmpty)
    }

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

private final class TimingFetchProbe: Sendable {
    struct Call: Sendable {
        let uri: String
        let timeout: TimeInterval
    }

    private let captured = OSAllocatedUnfairLock<[Call]>(initialState: [])
    private let payload: String
    private let failure: MCPClientError?
    var calls: [Call] { captured.withLock { $0 } }

    init(payload: String = "{}", failure: MCPClientError? = nil) {
        self.payload = payload
        self.failure = failure
    }

    func fetch(_ uri: String, timeout: TimeInterval) async throws -> String {
        captured.withLock { $0.append(Call(uri: uri, timeout: timeout)) }
        if let failure { throw failure }
        return payload
    }
}
