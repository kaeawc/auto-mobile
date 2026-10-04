@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class CommandHierarchyCaptureTests: XCTestCase {
    func testHierarchyRequestRecordsRawFilteredCaptureBeforeEnrichment() async throws {
        let fixture = CaptureFixture()
        let request = try JSONDecoder().decode(RequestHierarchy.self, from: Data(#"{"requestId":"capture"}"#.utf8))
        let response = try await fixture.handler.handleRequestHierarchy(request, startTime: Date())

        XCTAssertEqual(response.type, "hierarchy_update")
        XCTAssertEqual(response.data?.updatedAt, fixture.raw.updatedAt)
        XCTAssertEqual(response.data?.insets.source, "ios-sdk-safe-area")
        try fixture.assertRawCaptures(count: 1)
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
