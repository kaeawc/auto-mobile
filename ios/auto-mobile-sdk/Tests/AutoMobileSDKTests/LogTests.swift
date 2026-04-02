import XCTest
@testable import AutoMobileSDK

final class AutoMobileLogTests: XCTestCase {
    override func tearDown() {
        AutoMobileLog.shared.reset()
        super.tearDown()
    }

    func testLogMethodsDoNotCrash() {
        // Log methods are thin wrappers around os.Logger.
        // Verify they don't crash when called before initialization.
        AutoMobileLog.shared.v("tag", "verbose message")
        AutoMobileLog.shared.d("tag", "debug message")
        AutoMobileLog.shared.i("tag", "info message")
        AutoMobileLog.shared.w("tag", "warning message")
        AutoMobileLog.shared.e("tag", "error message")
        AutoMobileLog.shared.fault("tag", "fault message")
    }

    func testLogMethodsWithNilTag() {
        AutoMobileLog.shared.v(nil, "verbose no tag")
        AutoMobileLog.shared.d(nil, "debug no tag")
        AutoMobileLog.shared.i(nil, "info no tag")
    }

    // MARK: - Filter API

    func testAddAndRemoveFilter() {
        AutoMobileLog.shared.addFilter(name: "test-filter")
        XCTAssertEqual(AutoMobileLog.shared.filterNames, ["test-filter"])

        AutoMobileLog.shared.removeFilter(name: "test-filter")
        XCTAssertTrue(AutoMobileLog.shared.filterNames.isEmpty)
    }

    func testAddFilterReplacesExisting() {
        AutoMobileLog.shared.addFilter(name: "f1", minLevel: .verbose)
        AutoMobileLog.shared.addFilter(name: "f1", minLevel: .error)
        XCTAssertEqual(AutoMobileLog.shared.filterNames.count, 1)
    }

    func testClearFilters() {
        AutoMobileLog.shared.addFilter(name: "a")
        AutoMobileLog.shared.addFilter(name: "b")
        AutoMobileLog.shared.clearFilters()
        XCTAssertTrue(AutoMobileLog.shared.filterNames.isEmpty)
    }

    func testRemoveNonexistentFilterIsNoOp() {
        AutoMobileLog.shared.removeFilter(name: "does-not-exist")
        XCTAssertTrue(AutoMobileLog.shared.filterNames.isEmpty)
    }

    func testResetClearsFilters() {
        AutoMobileLog.shared.addFilter(name: "f1")
        AutoMobileLog.shared.addFilter(name: "f2")
        AutoMobileLog.shared.reset()
        XCTAssertTrue(AutoMobileLog.shared.filterNames.isEmpty)
    }

    // MARK: - LogFilter matching

    func testFilterMatchesAllWhenNoPatterns() {
        let filter = LogFilter(name: "all")
        XCTAssertTrue(filter.matches(tag: "any", message: "anything", level: .verbose))
        XCTAssertTrue(filter.matches(tag: nil, message: "anything", level: .fault))
    }

    func testFilterRejectsLevelBelowMinimum() {
        let filter = LogFilter(name: "warn+", minLevel: .warning)
        XCTAssertFalse(filter.matches(tag: "t", message: "m", level: .debug))
        XCTAssertTrue(filter.matches(tag: "t", message: "m", level: .warning))
        XCTAssertTrue(filter.matches(tag: "t", message: "m", level: .error))
    }

    func testFilterMatchesTagPattern() throws {
        let regex = try NSRegularExpression(pattern: "^Net")
        let filter = LogFilter(name: "net", tagPattern: regex)
        XCTAssertTrue(filter.matches(tag: "Network", message: "request", level: .info))
        XCTAssertFalse(filter.matches(tag: "Database", message: "request", level: .info))
    }

    func testFilterMatchesMessagePattern() throws {
        let regex = try NSRegularExpression(pattern: "error|fail", options: .caseInsensitive)
        let filter = LogFilter(name: "errors", messagePattern: regex)
        XCTAssertTrue(filter.matches(tag: "t", message: "request failed", level: .info))
        XCTAssertFalse(filter.matches(tag: "t", message: "request succeeded", level: .info))
    }

    func testFilterWithNilTagDoesNotMatchTagPattern() throws {
        let regex = try NSRegularExpression(pattern: "Net")
        let filter = LogFilter(name: "net", tagPattern: regex)
        XCTAssertFalse(filter.matches(tag: nil, message: "msg", level: .info))
    }

    func testFilterCombinesAllCriteria() throws {
        let tagRegex = try NSRegularExpression(pattern: "^API")
        let msgRegex = try NSRegularExpression(pattern: "timeout")
        let filter = LogFilter(name: "api-timeout", tagPattern: tagRegex, messagePattern: msgRegex, minLevel: .warning)

        // All criteria met
        XCTAssertTrue(filter.matches(tag: "APIClient", message: "connection timeout", level: .error))
        // Tag mismatch
        XCTAssertFalse(filter.matches(tag: "DB", message: "connection timeout", level: .error))
        // Message mismatch
        XCTAssertFalse(filter.matches(tag: "APIClient", message: "success", level: .error))
        // Level too low
        XCTAssertFalse(filter.matches(tag: "APIClient", message: "connection timeout", level: .debug))
    }

    // MARK: - Buffering integration

    func testMatchingLogIsBuffered() {
        let buffer = FakeEventBuffer()
        AutoMobileLog.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileLog.shared.addFilter(name: "all")

        AutoMobileLog.shared.i("Net", "request sent")

        XCTAssertEqual(buffer.events.count, 1)
        let event = buffer.events.first as? SdkLogEvent
        XCTAssertEqual(event?.level, .info)
        XCTAssertEqual(event?.tag, "Net")
        XCTAssertEqual(event?.message, "request sent")
    }

    func testNonMatchingLogIsNotBuffered() {
        let buffer = FakeEventBuffer()
        AutoMobileLog.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileLog.shared.addFilter(name: "errors-only", minLevel: .error)

        AutoMobileLog.shared.d("t", "debug msg")

        XCTAssertTrue(buffer.events.isEmpty)
    }

    func testLogWithoutFiltersIsNotBuffered() {
        let buffer = FakeEventBuffer()
        AutoMobileLog.shared.initialize(bundleId: "test", buffer: buffer)

        AutoMobileLog.shared.e("t", "error msg")

        XCTAssertTrue(buffer.events.isEmpty)
    }

    func testLogWithoutBufferDoesNotCrash() {
        AutoMobileLog.shared.addFilter(name: "all")
        AutoMobileLog.shared.i("t", "msg")
        // No crash = pass
    }

    func testFaultLevelIsBuffered() {
        let buffer = FakeEventBuffer()
        AutoMobileLog.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileLog.shared.addFilter(name: "all")

        AutoMobileLog.shared.fault("t", "critical")

        XCTAssertEqual(buffer.events.count, 1)
        let event = buffer.events.first as? SdkLogEvent
        XCTAssertEqual(event?.level, .fault)
    }

    func testOnlyFirstMatchingFilterBuffersOnce() {
        let buffer = FakeEventBuffer()
        AutoMobileLog.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileLog.shared.addFilter(name: "a")
        AutoMobileLog.shared.addFilter(name: "b")

        AutoMobileLog.shared.i("t", "msg")

        // Should buffer exactly once even with two matching filters
        XCTAssertEqual(buffer.events.count, 1)
    }
}
