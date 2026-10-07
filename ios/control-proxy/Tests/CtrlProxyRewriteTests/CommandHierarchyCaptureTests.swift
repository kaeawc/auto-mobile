@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class CommandHierarchyCaptureTests: XCTestCase {
    func testCaptureRecordsIntoRealDebouncerWhenWallClockStepsBack() async throws {
        let initial = ViewHierarchy(updatedAt: 20, hierarchy: UIElementInfo(text: "initial"))
        let captured = ViewHierarchy(updatedAt: 10, hierarchy: UIElementInfo(text: "command"))
        let locator = RewriteFakeElementLocator(hierarchy: captured)
        let perf = FakePerfTracking(flushResult: nil)
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: RewriteFakeElementLocator(hierarchy: initial),
            perf: perf, timer: FakeProxyTimer(mode: .manual)
        )
        debouncer.start()
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: perf, hierarchyDebouncer: debouncer
        )

        let result = try await handler.captureHierarchy()

        XCTAssertEqual(result.updatedAt, 10)
        XCTAssertEqual(result.hierarchy?.text, "command")
        XCTAssertEqual(debouncer.getLastHierarchy()?.updatedAt, 10)
        XCTAssertEqual(debouncer.getLastHierarchy()?.hierarchy?.text, "command")
        XCTAssertEqual(locator.filteringRequests, [false])
    }

    func testEarlierCommandCaptureCannotReplaceLaterPoll() async throws {
        let polled = ViewHierarchy(updatedAt: 10, hierarchy: UIElementInfo(text: "poll"))
        let captured = ViewHierarchy(updatedAt: 20, hierarchy: UIElementInfo(text: "command"))
        let locator = RewriteFakeElementLocator(hierarchy: captured)
        let timer = FakeProxyTimer(mode: .manual)
        let perf = FakePerfTracking(flushResult: nil)
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: RewriteFakeElementLocator(hierarchy: polled), perf: perf, timer: timer
        )
        debouncer.start()
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: perf, hierarchyDebouncer: debouncer
        )
        // Synchronously complete a later poll during command extraction. This models
        // reversed completion order without sleeps or main-queue scheduling assumptions.
        locator.onCapture = { timer.advance(by: 1000) }

        let result = try await handler.captureHierarchy()

        XCTAssertEqual(result.updatedAt, 20)
        XCTAssertEqual(result.hierarchy?.text, "command")
        XCTAssertEqual(debouncer.getLastHierarchy()?.updatedAt, 10)
        XCTAssertEqual(debouncer.getLastHierarchy()?.hierarchy?.text, "poll")
        XCTAssertEqual(locator.filteringRequests, [false])
    }

    func testUnfilteredCaptureLeavesRealDebouncerUnchanged() async throws {
        let initial = ViewHierarchy(updatedAt: 10, hierarchy: UIElementInfo(text: "initial"))
        let captured = ViewHierarchy(updatedAt: 20, hierarchy: UIElementInfo(text: "unfiltered"))
        let locator = RewriteFakeElementLocator(hierarchy: captured)
        let perf = FakePerfTracking(flushResult: nil)
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: RewriteFakeElementLocator(hierarchy: initial),
            perf: perf, timer: FakeProxyTimer(mode: .manual)
        )
        debouncer.start()
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: perf, hierarchyDebouncer: debouncer
        )

        let result = try await handler.captureHierarchy(disableAllFiltering: true)

        XCTAssertEqual(result.hierarchy?.text, "unfiltered")
        XCTAssertEqual(debouncer.getLastHierarchy()?.updatedAt, 10)
        XCTAssertEqual(debouncer.getLastHierarchy()?.hierarchy?.text, "initial")
        XCTAssertEqual(locator.filteringRequests, [true])
    }

    func testFailedCaptureLeavesRealDebouncerUnchanged() async {
        let locator = RewriteFakeElementLocator()
        let perf = FakePerfTracking(flushResult: nil)
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: locator, perf: perf, timer: FakeProxyTimer(mode: .manual)
        )
        debouncer.start()
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: perf, hierarchyDebouncer: debouncer
        )
        locator.onCapture = { throw CommandError.executionFailed("scripted extraction failure") }

        do {
            _ = try await handler.captureHierarchy()
            XCTFail("Expected extraction failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Command execution failed: scripted extraction failure")
        }

        XCTAssertEqual(debouncer.getLastHierarchy()?.updatedAt, RewriteFakeElementLocator.defaultHierarchy.updatedAt)
        XCTAssertEqual(debouncer.getLastHierarchy()?.hierarchy?.text, "Fake Root")
        XCTAssertEqual(locator.filteringRequests, [false, false])
    }

    func testHierarchyRequestRecordsRawFilteredCaptureBeforeEnrichment() async throws {
        let fixture = CaptureFixture()
        let request = try JSONDecoder().decode(RequestHierarchy.self, from: Data(#"{"requestId":"capture"}"#.utf8))
        let response = try await fixture.handler.handleRequestHierarchy(request, startTime: Date())

        XCTAssertEqual(response.type, "hierarchy_update")
        XCTAssertEqual(response.data?.updatedAt, fixture.raw.updatedAt)
        XCTAssertEqual(response.data?.insets.source, "ios-sdk-safe-area")
        try fixture.assertRawCaptures(count: 1)
    }

    func testRequestHierarchyIfStaleCapturesFreshOnEveryRequest() async throws {
        let fixture = CaptureFixture()
        let decoder = JSONDecoder()
        let first = try decoder.decode(
            WebSocketRequest.self, from: Data(#"{"type":"request_hierarchy_if_stale","requestId":"first"}"#.utf8)
        )
        let second = try decoder.decode(
            WebSocketRequest.self, from: Data(#"{"type":"request_hierarchy_if_stale","requestId":"second"}"#.utf8)
        )

        _ = await fixture.handler.handle(first)
        _ = await fixture.handler.handle(second)

        try fixture.assertRawCaptures(count: 2)
    }

    func testRequestHierarchyIfStaleIgnoresLegacySinceTimestamp() throws {
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(#"{"type":"request_hierarchy_if_stale","requestId":"legacy","sinceTimestamp":123}"#.utf8)
        )

        guard case let .requestHierarchyIfStale(payload) = request else {
            return XCTFail("Expected request_hierarchy_if_stale")
        }
        XCTAssertEqual(payload.requestId, "legacy")
    }

    func testUnfilteredHierarchyRequestDoesNotRecord() async throws {
        let fixture = CaptureFixture()
        let request = try JSONDecoder().decode(
            RequestHierarchy.self, from: Data(#"{"disableAllFiltering":true}"#.utf8)
        )
        let response = try await fixture.handler.handleRequestHierarchy(request, startTime: Date())

        XCTAssertEqual(response.data?.updatedAt, fixture.raw.updatedAt)
        XCTAssertEqual(fixture.locator.filteringRequests, [true])
        XCTAssertTrue(fixture.debouncer.recordedCaptures.isEmpty)
    }

    func testContextCheckedGestureRecordsRawCapture() async throws {
        let fixture = CaptureFixture()
        let expected = try XCTUnwrap(fixture.handler.frameContext.context(
            for: fixture.handler.enrichWithCachedSdkHierarchy(fixture.raw)
        ))
        try await fixture.handler.performContextCheckedGesture(expected: expected) {
            try fixture.gestures.tap(x: 1, y: 2, duration: 0)
        }

        XCTAssertEqual(fixture.gestures.tapCalls, 1)
        try fixture.assertRawCaptures(count: 1)
    }

    func testAsyncContextCheckedGestureRecordsRawCapture() async throws {
        let fixture = CaptureFixture()
        let expected = try XCTUnwrap(fixture.handler.frameContext.context(
            for: fixture.handler.enrichWithCachedSdkHierarchy(fixture.raw)
        ))
        try await fixture.handler.performContextCheckedGestureAsync(expected: expected) {
            try await fixture.gestures.setText(resourceId: "field", text: "value")
        }

        XCTAssertEqual(fixture.gestures.setTextCalls, 1)
        try fixture.assertRawCaptures(count: 1)
    }

    func testContextlessGesturesStillSkipCapture() async throws {
        let fixture = CaptureFixture()
        try await fixture.handler.performContextCheckedGesture(expected: nil) {}
        try await fixture.handler.performContextCheckedGestureAsync(expected: nil) {}
        XCTAssertTrue(fixture.locator.filteringRequests.isEmpty)
        XCTAssertTrue(fixture.debouncer.recordedCaptures.isEmpty)
    }

    func testCorrelatedScreenshotRecordsBothRawCaptures() async throws {
        let fixture = CaptureFixture()
        let request = try JSONDecoder().decode(
            RequestEnvelope.self, from: Data(#"{"frameContext":"correlate"}"#.utf8)
        )
        let response = try await fixture.handler.handleRequestScreenshot(request, startTime: Date())

        XCTAssertNotNil(response.frameContext)
        try fixture.assertRawCaptures(count: 2)
    }

    func testAccessibilityQueriesRecordRawCaptures() async throws {
        let fixture = CaptureFixture()
        let request = try JSONDecoder().decode(RequestEnvelope.self, from: Data("{}".utf8))
        _ = try await fixture.handler.handleGetCurrentFocus(request, startTime: Date())
        _ = try await fixture.handler.handleGetTraversalOrder(request, startTime: Date())
        try fixture.assertRawCaptures(count: 2)
    }

    func testRotationAxisReadRecordsRawCapture() async throws {
        let fixture = CaptureFixture()
        let request = try JSONDecoder().decode(RequestRotate.self, from: Data(#"{"orientation":"portrait"}"#.utf8))
        let response = try await fixture.handler.handleRotate(request, startTime: Date())

        XCTAssertTrue(response.success)
        XCTAssertFalse(response.rotationPerformed)
        try fixture.assertRawCaptures(count: 1)
    }
}

@MainActor
private final class CaptureFixture {
    let raw = RewriteFakeElementLocator.defaultHierarchy
    let locator: RewriteFakeElementLocator
    let gestures = RewriteFakeGesturePerformer()
    let debouncer = RewriteFakeHierarchyDebouncer()
    let handler: CommandHandler

    init() {
        locator = RewriteFakeElementLocator(hierarchy: raw)
        locator.appState = .runningForeground
        let cache = SdkHierarchyCache()
        cache.update(SdkViewHierarchy(
            timestamp: 2, bundleId: raw.packageName, screenScale: 3, screenWidth: 375, screenHeight: 812,
            safeAreaInsets: SdkEdgeInsets(top: 20, right: 0, bottom: 10, left: 0), root: nil
        ))
        handler = CommandHandler(
            elementLocator: locator, gesturePerformer: gestures, perf: FakePerfTracking(flushResult: nil),
            sdkHierarchyCache: cache, hierarchyDebouncer: debouncer,
            rotationTimer: FakeProxyTimer(mode: .manual)
        )
    }

    func assertRawCaptures(count: Int, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(debouncer.recordedCaptures.count, count, file: file, line: line)
        XCTAssertEqual(locator.filteringRequests, Array(repeating: false, count: count), file: file, line: line)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let expected = try encoder.encode(raw)
        for capture in debouncer.recordedCaptures {
            XCTAssertEqual(try encoder.encode(capture), expected, file: file, line: line)
        }
        XCTAssertTrue(debouncer.pollIntervals.isEmpty, file: file, line: line)
    }
}
