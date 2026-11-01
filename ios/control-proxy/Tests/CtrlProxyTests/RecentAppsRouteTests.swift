@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class RecentAppsRouteTests: XCTestCase {
    func testAlreadyOpenDoesNotToggleOrSleep() async throws {
        let clock = KeyboardTestClock()
        var gestures = 0
        let outcome = try await RecentAppsNavigation.openSimulator(
            clock: clock, isVisible: { true }, doubleHome: { gestures += 1 }
        )
        XCTAssertTrue(outcome.visible)
        XCTAssertEqual(outcome.route, "already-open")
        XCTAssertEqual(gestures, 0)
        XCTAssertEqual(clock.sleeps, [])
    }

    func testFirstVerifiedGestureStopsRetries() async throws {
        let clock = KeyboardTestClock()
        var gestures = 0
        let outcome = try await RecentAppsNavigation.openSimulator(
            clock: clock, isVisible: { gestures > 0 }, doubleHome: { gestures += 1 }
        )
        XCTAssertTrue(outcome.visible)
        XCTAssertEqual(outcome.route, "sim-hid-home-double")
        XCTAssertEqual(gestures, 1)
        XCTAssertEqual(clock.sleeps, [])
    }

    func testSecondGestureCanVerifyAfterFirstAttemptSettles() async throws {
        let clock = KeyboardTestClock()
        var gestures = 0
        let outcome = try await RecentAppsNavigation.openSimulator(
            clock: clock, isVisible: { gestures == 2 }, doubleHome: { gestures += 1 }
        )
        XCTAssertTrue(outcome.visible)
        XCTAssertEqual(gestures, 2)
        XCTAssertEqual(clock.elapsedMs, 1500)
    }

    func testFailedGesturesNeverClaimSuccessAndHaveBoundedPolling() async throws {
        let clock = KeyboardTestClock()
        var gestures = 0
        let outcome = try await RecentAppsNavigation.openSimulator(
            clock: clock, isVisible: { false }, doubleHome: { gestures += 1 }
        )
        XCTAssertFalse(outcome.visible)
        XCTAssertEqual(outcome.route, "sim-hid-home-double")
        XCTAssertEqual(gestures, 2)
        XCTAssertEqual(clock.elapsedMs, 3000)
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(100), count: 30))
    }

    func testVisibilityAtSettleDeadlinePreventsAnotherToggle() async throws {
        let clock = KeyboardTestClock()
        var gestures = 0
        let outcome = try await RecentAppsNavigation.openSimulator(
            clock: clock, isVisible: { clock.elapsedMs >= 1500 }, doubleHome: { gestures += 1 }
        )
        XCTAssertTrue(outcome.visible)
        XCTAssertEqual(gestures, 1)
        XCTAssertEqual(clock.elapsedMs, 1500)
    }

    func testRunnerFailureCarriesRouteWithoutChangingForegroundTracking() async throws {
        let locator = FakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let gestures = FakeGesturePerformer()
        gestures.recentAppsOutcome = RecentAppsOutcome(visible: false, route: "sim-hid-home-double")
        let handler = CommandHandler(elementLocator: locator, gesturePerformer: gestures, perf: PerfProvider())
        let request = try JSONDecoder().decode(RequestEnvelope.self, from: Data(
            #"{"type":"request_recent_apps","requestId":"recent-1"}"#.utf8
        ))
        let response = try await handler.handleRecentApps(request, startTime: Date())
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.recentAppsRoute, "sim-hid-home-double")
        XCTAssertTrue(try XCTUnwrap(response.error).contains("Observe the screen; call homeScreen then retry"))
        XCTAssertEqual(locator.foregroundBundleId, "com.example.app")
    }

    func testVerifiedRunnerSuccessAndTimingCopyCarryRoute() async throws {
        let gestures = FakeGesturePerformer()
        gestures.recentAppsOutcome = RecentAppsOutcome(visible: true, route: "already-open")
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let request = try JSONDecoder().decode(RequestEnvelope.self, from: Data(
            #"{"type":"request_recent_apps","requestId":"recent-2"}"#.utf8
        ))
        let response = try await handler.handleRecentApps(request, startTime: Date())
        let copied = response.withPerfTiming(PerfTiming(name: "total", durationMs: 1), totalTimeMs: 9)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: JSONEncoder().encode(copied))
        XCTAssertEqual(decoded.success, true)
        XCTAssertEqual(decoded.recentAppsRoute, "already-open")
    }
}
