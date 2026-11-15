import ObjectiveC.runtime
import XCTest
@testable import XCTestRunner

final class AutoMobileTestSelectionTests: XCTestCase {
    /// Compare runtime implementations without constructing a suite or running Reminders setup.
    func testPlanBaseClassesInheritXCTestSuiteDiscovery() throws {
        let xctestImplementation = try suiteImplementation(for: XCTestCase.self)

        XCTAssertEqual(try suiteImplementation(for: AutoMobileTestCase.self), xctestImplementation)
        XCTAssertEqual(try suiteImplementation(for: RemindersAddPlanTests.self), xctestImplementation)
    }

    func testTimingOrderingExplicitlyOverridesSuiteDiscovery() throws {
        XCTAssertNotEqual(
            try suiteImplementation(for: AutoMobileTimingOrderedTestCase.self),
            try suiteImplementation(for: XCTestCase.self)
        )
    }

    private func suiteImplementation(for testClass: AnyClass) throws -> UnsafeRawPointer {
        let method = try XCTUnwrap(
            class_getClassMethod(testClass, #selector(getter: XCTestCase.defaultTestSuite))
        )
        return unsafeBitCast(method_getImplementation(method), to: UnsafeRawPointer.self)
    }
}

final class AutoMobileTimingOrderingTests: XCTestCase {
    func testOrderingKeepsTiesStableAndUntimedTestsLast() {
        let unknownFirst = XCTestSuite(name: "unknown-first")
        let slow = XCTestSuite(name: "slow")
        let fastFirst = XCTestSuite(name: "fast-first")
        let fastSecond = XCTestSuite(name: "fast-second")
        let unknownLast = XCTestSuite(name: "unknown-last")
        let candidates = [
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: unknownFirst, index: 0, durationMs: nil),
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: slow, index: 1, durationMs: 20),
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: fastFirst, index: 2, durationMs: 10),
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: fastSecond, index: 3, durationMs: 10),
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: unknownLast, index: 4, durationMs: nil),
        ]

        XCTAssertEqual(
            AutoMobileTimingOrderedTestCase.orderTimingCandidates(candidates, strategy: .durationAsc).map(\.name),
            ["fast-first", "fast-second", "slow", "unknown-first", "unknown-last"]
        )
        XCTAssertEqual(
            AutoMobileTimingOrderedTestCase.orderTimingCandidates(candidates, strategy: .durationDesc).map(\.name),
            ["slow", "fast-first", "fast-second", "unknown-first", "unknown-last"]
        )
        XCTAssertEqual(
            AutoMobileTimingOrderedTestCase.orderTimingCandidates(candidates, strategy: .disabled).map(\.name),
            candidates.map { $0.test.name }
        )
    }

    func testOrderingWithoutTimingPreservesInput() {
        let candidates = [
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: XCTestSuite(name: "b"), index: 0, durationMs: nil),
            AutoMobileTimingOrderedTestCase.TimingCandidate(test: XCTestSuite(name: "a"), index: 1, durationMs: nil),
        ]

        XCTAssertEqual(
            AutoMobileTimingOrderedTestCase.orderTimingCandidates(candidates, strategy: .durationAsc).map(\.name),
            ["b", "a"]
        )
        XCTAssertTrue(AutoMobileTimingOrderedTestCase.orderTimingCandidates([], strategy: .durationDesc).isEmpty)
    }
}
