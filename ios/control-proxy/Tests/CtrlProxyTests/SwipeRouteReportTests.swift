@testable import CtrlProxy
import Foundation
import XCTest

/// #13145: the swipe reply names the dispatch route that ran and the stroke duration it used, so
/// hosts stop assuming the XCUICoordinate clamp for every route.
@MainActor
final class SwipeRouteReportTests: XCTestCase {
    func testXcuiCoordinateReportsTheClampedStrokeDuration() {
        // 100 pt over 3000 ms is 33 pt/s, clamped up to 100 pt/s: the stroke runs 1000 ms.
        let slow = SwipeDispatchReport.xcuiCoordinate(distance: 100, duration: 3)
        XCTAssertEqual(slow, SwipeDispatchReport(route: .xcuiCoordinate, effectiveDurationMs: 1000))
        // 1000 pt over 10 ms is 100000 pt/s, clamped down to 10000 pt/s: 100 ms.
        let fast = SwipeDispatchReport.xcuiCoordinate(distance: 1000, duration: 0.01)
        XCTAssertEqual(fast.effectiveDurationMs, 100)
        // In range: unchanged.
        XCTAssertEqual(SwipeDispatchReport.xcuiCoordinate(distance: 300, duration: 0.3).effectiveDurationMs, 300)
        // No usable distance: the runner passes no velocity, so the requested duration stands.
        XCTAssertEqual(SwipeDispatchReport.xcuiCoordinate(distance: 0, duration: 0.2).effectiveDurationMs, 200)
    }

    func testSynthesizedRoutesReportTheirOwnDuration() {
        XCTAssertEqual(
            SwipeDispatchReport.unpinnedSynthesized(duration: 0.01),
            SwipeDispatchReport(route: .unpinnedSynthesized, effectiveDurationMs: 50)
        )
        XCTAssertEqual(SwipeDispatchReport.unpinnedSynthesized(duration: 0.4).effectiveDurationMs, 400)
        XCTAssertEqual(
            SwipeDispatchReport.lockScreenSynthesized(duration: 0.25),
            SwipeDispatchReport(route: .lockScreenSynthesized, effectiveDurationMs: 250)
        )
    }

    func testWireStringsAreStable() {
        XCTAssertEqual(SwipeRoute.xcuiCoordinate.rawValue, "xcuiCoordinate")
        XCTAssertEqual(SwipeRoute.unpinnedSynthesized.rawValue, "unpinnedSynthesized")
        XCTAssertEqual(SwipeRoute.lockScreenSynthesized.rawValue, "lockScreenSynthesized")
    }

    private func swipeResponse(
        gestures: FakeGesturePerformer, lockScreen: Bool
    )
        async throws -> [String: Any]
    {
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        let json = #"{"type":"request_swipe","requestId":"r","x1":0,"y1":0,"x2":100,"y2":0,"#
            + #""duration":10,"lockScreen":\#(lockScreen)}"#
        let request = try JSONDecoder().decode(RequestSwipe.self, from: Data(json.utf8))
        let response = try await handler.handleSwipe(
            request, startTime: Date(), deadlineMs: nil, monotonicNowMs: { 0 }
        )
        let data = try JSONEncoder().encode(response)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testSwipeResultCarriesRouteAndEffectiveDuration() async throws {
        let gestures = FakeGesturePerformer()
        gestures.swipeReport = .unpinnedSynthesized(duration: 0.01)
        let body = try await swipeResponse(gestures: gestures, lockScreen: false)
        XCTAssertEqual(body["swipeRoute"] as? String, "unpinnedSynthesized")
        XCTAssertEqual(body["effectiveDurationMs"] as? Int, 50)
        XCTAssertEqual(gestures.swipeCalls, 1)
    }

    func testLockScreenSwipeResultCarriesLockScreenRoute() async throws {
        let gestures = FakeGesturePerformer()
        gestures.swipeReport = .lockScreenSynthesized(duration: 0.01)
        let body = try await swipeResponse(gestures: gestures, lockScreen: true)
        XCTAssertEqual(body["swipeRoute"] as? String, "lockScreenSynthesized")
        XCTAssertEqual(body["effectiveDurationMs"] as? Int, 10)
        XCTAssertEqual(gestures.lockScreenSwipeCalls, 1)
    }

    func testPerformerThatCannotReportOmitsTheFields() async throws {
        let body = try await swipeResponse(gestures: FakeGesturePerformer(), lockScreen: false)
        XCTAssertNil(body["swipeRoute"])
        XCTAssertNil(body["effectiveDurationMs"])
        XCTAssertEqual(body["success"] as? Bool, true)
    }

    func testPerfTimingCopyKeepsTheSwipeReport() throws {
        let response = WebSocketResponse(
            type: "swipe_result", totalTimeMs: 5, swipeRoute: "xcuiCoordinate", effectiveDurationMs: 1000
        )
        let copied = response.withPerfTiming(PerfTiming(name: "total", durationMs: 1), totalTimeMs: 9)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: JSONEncoder().encode(copied))
        XCTAssertEqual(decoded.swipeRoute, "xcuiCoordinate")
        XCTAssertEqual(decoded.effectiveDurationMs, 1000)
    }
}
