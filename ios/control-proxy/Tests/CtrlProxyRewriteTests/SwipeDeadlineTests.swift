@testable import CtrlProxyRewrite
import Foundation
import XCTest

private struct DeadlineForwardingHandler: CommandHandling {
    let swipeHandler: CommandHandler
    let other: @Sendable (WebSocketRequest) -> any WebSocketResponsePayload

    func handle(_ request: WebSocketRequest) async -> any WebSocketResponsePayload {
        await handle(request, deadlineMs: nil, monotonicNowMs: { 0 })
    }

    func handle(
        _ request: WebSocketRequest, deadlineMs: Int64?, monotonicNowMs: @escaping @Sendable () -> Int64
    )
        async -> any WebSocketResponsePayload
    {
        if case .swipe = request {
            return await swipeHandler.handle(request, deadlineMs: deadlineMs, monotonicNowMs: monotonicNowMs)
        }
        return other(request)
    }
}

@MainActor
final class SwipeDeadlineTests: XCTestCase {
    private func swipe(_ id: String, timeout: String = "") -> Data {
        Data("""
        {"type":"request_swipe","requestId":"\(id)","x1":1,"y1":2,"x2":3,"y2":4\(timeout)}
        """.utf8)
    }

    private func response(_ responder: CapturingResponder) throws -> [String: Any] {
        let data = try XCTUnwrap(responder.captured.first)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func server(
        gestures: RewriteFakeGesturePerformer, clock: FakeMonotonicClock,
        other: @escaping @Sendable (WebSocketRequest) -> any WebSocketResponsePayload = { request in
            WebSocketResponse.success(type: "screenshot", requestId: request.requestId, totalTimeMs: 0)
        }
    )
        -> WebSocketServer
    {
        WebSocketServer(
            commandHandler: DeadlineForwardingHandler(
                swipeHandler: CommandHandler(
                    elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
                    perf: FakePerfTracking(flushResult: nil)
                ), other: other
            ),
            perf: FakePerfTracking(flushResult: nil),
            frameContext: FakeFrameContextRecording(token: nil),
            busyBudgetMs: 3000,
            monotonicNowMs: { clock.now() }
        )
    }

    func testSwipeWithoutTimeoutKeepsLegacySuccessShape() async throws {
        let clock = FakeMonotonicClock()
        let gestures = RewriteFakeGesturePerformer()
        let server = server(gestures: gestures, clock: clock)
        let done = expectation(description: "swipe response")
        let responder = CapturingResponder(onEach: { done.fulfill() })

        server.dispatchCommand(swipe("legacy"), responder: responder)
        await fulfillment(of: [done], timeout: 2)

        let result = try response(responder)
        XCTAssertEqual(gestures.swipeCalls, 1)
        XCTAssertEqual(result["type"] as? String, "swipe_result")
        XCTAssertEqual(result["success"] as? Bool, true)
        XCTAssertEqual(Set(result.keys), Set(["type", "timestamp", "requestId", "success", "totalTimeMs"]))
    }

    func testQueuedSwipeExpiresBeforeGestureAndReleasesBusyGuard() async throws {
        let clock = FakeMonotonicClock()
        let gestures = RewriteFakeGesturePerformer()
        let started = expectation(description: "blocker started")
        let blockerDone = expectation(description: "blocker response")
        let swipeDone = expectation(description: "swipe timeout response")
        let nextDone = expectation(description: "next response")
        let release = DispatchSemaphore(value: 0)
        let server = server(gestures: gestures, clock: clock, other: { request in
            if request.requestId == "blocker" {
                started.fulfill()
                release.wait()
            }
            return WebSocketResponse.success(type: "screenshot", requestId: request.requestId, totalTimeMs: 0)
        })
        let blocker = CapturingResponder(onEach: { blockerDone.fulfill() })
        let swipeResponder = CapturingResponder(onEach: { swipeDone.fulfill() })
        let next = CapturingResponder(onEach: { nextDone.fulfill() })

        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"blocker"}"#.utf8), responder: blocker)
        await fulfillment(of: [started], timeout: 2)
        server.dispatchCommand(swipe("queued", timeout: ",\"timeoutMs\":5000"), responder: swipeResponder)
        clock.advance(by: 6000)
        release.signal()
        await fulfillment(of: [blockerDone, swipeDone], timeout: 2)

        let timeout = try response(swipeResponder)
        XCTAssertEqual(gestures.swipeCalls, 0)
        XCTAssertEqual(timeout["success"] as? Bool, false)
        XCTAssertEqual(
            timeout["error"] as? String,
            "Command request_swipe exceeded deadline at 5000ms (gesture was not started)"
        )

        clock.advance(by: 4000)
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"next"}"#.utf8), responder: next)
        await fulfillment(of: [nextDone], timeout: 2)
        XCTAssertEqual(try response(next)["success"] as? Bool, true)
        XCTAssertNil(try response(next)["error"])
    }

    func testSwipeReturningAfterDeadlineReportsIndeterminateOutcomeAndReleasesGuard() async throws {
        let clock = FakeMonotonicClock()
        let gestures = RewriteFakeGesturePerformer()
        gestures.onSwipe = { clock.advance(by: 6000) }
        let server = server(gestures: gestures, clock: clock)
        let swipeDone = expectation(description: "late swipe response")
        let nextDone = expectation(description: "next response")
        let swipeResponder = CapturingResponder(onEach: { swipeDone.fulfill() })
        let next = CapturingResponder(onEach: { nextDone.fulfill() })

        server.dispatchCommand(swipe("late", timeout: ",\"timeoutMs\":5000"), responder: swipeResponder)
        await fulfillment(of: [swipeDone], timeout: 2)
        XCTAssertEqual(gestures.swipeCalls, 1)
        XCTAssertEqual(try response(swipeResponder)["success"] as? Bool, false)
        XCTAssertEqual(
            try response(swipeResponder)["error"] as? String,
            "Command request_swipe exceeded deadline at 5000ms (gesture completed after its deadline; outcome is indeterminate)"
        )

        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"next"}"#.utf8), responder: next)
        await fulfillment(of: [nextDone], timeout: 2)
        XCTAssertEqual(try response(next)["success"] as? Bool, true)
        XCTAssertNil(try response(next)["error"])
    }

    func testSwipeEnvelopeAcceptsOnlyPositiveIntegerTimeout() throws {
        for (field, expected) in [
            (",\"timeoutMs\":5000", 5000),
            ("", nil),
            (",\"timeoutMs\":0", nil),
            (",\"timeoutMs\":-1", nil),
            (",\"timeoutMs\":\"5000\"", nil),
            (",\"timeoutMs\":true", nil),
            (",\"timeoutMs\":5.5", nil),
        ] {
            let request = try JSONDecoder().decode(WebSocketRequest.self, from: swipe("decode", timeout: field))
            guard case let .swipe(payload) = request else {
                return XCTFail("Expected swipe payload")
            }
            XCTAssertEqual(payload.timeoutMs, expected)
        }
    }

    func testBusyResponseReportsSignedDeadlineRemaining() async throws {
        let clock = FakeMonotonicClock()
        let gestures = RewriteFakeGesturePerformer()
        let swipeDone = expectation(description: "swipe completed")
        let busyDone = expectation(description: "busy response")
        let server = server(gestures: gestures, clock: clock)
        let swipeResponder = CapturingResponder(onEach: { swipeDone.fulfill() })
        let busy = CapturingResponder(onEach: { busyDone.fulfill() })
        gestures.onSwipe = {
            clock.advance(by: 8000)
            server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"busy"}"#.utf8), responder: busy)
        }

        server.dispatchCommand(swipe("blocking", timeout: ",\"timeoutMs\":5000"), responder: swipeResponder)
        await fulfillment(of: [busyDone, swipeDone], timeout: 2)
        XCTAssertEqual(try response(busy)["error"] as? String, "runner_busy")
        XCTAssertEqual(try response(busy)["blockingDeadlineRemainingMs"] as? Int, -3000)
    }
}
