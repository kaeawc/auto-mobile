@testable import CtrlProxy
import Foundation
import XCTest

private struct LegacySwipePayload: Decodable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
}

private struct DeadlineForwardingHandler: CommandHandling {
    let swipeHandler: CommandHandler
    let other: @Sendable (WebSocketRequest) -> any WebSocketResponsePayload
    var tapGate: FakeProxyTimer?
    var swipeGate: FakeProxyTimer?

    func handle(_ request: WebSocketRequest) async -> any WebSocketResponsePayload {
        await handle(request, deadlineMs: nil, monotonicNowMs: { 0 })
    }

    func handle(
        _ request: WebSocketRequest, deadlineMs: Int64?, monotonicNowMs: @escaping @Sendable () -> Int64
    )
        async -> any WebSocketResponsePayload
    {
        await handle(request, deadlineMs: deadlineMs, monotonicNowMs: monotonicNowMs, deliveryAbandoned: { false })
    }

    func handle(
        _ request: WebSocketRequest, deadlineMs: Int64?, monotonicNowMs: @escaping @Sendable () -> Int64,
        deliveryAbandoned: @escaping @Sendable () -> Bool
    )
        async -> any WebSocketResponsePayload
    {
        switch request {
        case .swipe, .tapCoordinates:
            if case .tapCoordinates = request, let tapGate {
                await tapGate.wait(milliseconds: 1)
            }
            if case .swipe = request, let swipeGate {
                await swipeGate.wait(milliseconds: 1)
            }
            return await swipeHandler.handle(
                request, deadlineMs: deadlineMs, monotonicNowMs: monotonicNowMs,
                deliveryAbandoned: deliveryAbandoned
            )
        default:
            return other(request)
        }
    }
}

@MainActor
final class SwipeDeadlineTests: XCTestCase {
    private func tap(_ id: String, fields: String = "") -> Data {
        Data("""
        {"type":"request_tap_coordinates","requestId":"\(id)","x":1.5,"y":2.5\(fields)}
        """.utf8)
    }

    func testTapEnvelopeAcceptsOnlyPositiveIntegerTimeout() throws {
        for (field, expected) in [
            (",\"timeoutMs\":5000", 5000), ("", nil), (",\"timeoutMs\":null", nil),
            (",\"timeoutMs\":0", nil), (",\"timeoutMs\":-1", nil),
            (",\"timeoutMs\":\"5000\"", nil), (",\"timeoutMs\":true", nil),
            (",\"timeoutMs\":5.5", nil), (",\"timeoutMs\":{}", nil),
        ] {
            let request = try JSONDecoder().decode(WebSocketRequest.self, from: tap("decode", fields: field))
            guard case let .tapCoordinates(payload) = request else { return XCTFail("Expected tap payload") }
            XCTAssertEqual(payload.timeoutMs, expected)
            XCTAssertEqual(payload.x, 1.5)
            XCTAssertEqual(payload.y, 2.5)
        }
        let payload = try JSONDecoder().decode(RequestTapCoordinates.self, from: tap(
            "options",
            fields: ",\"duration\":25,\"doubleTap\":true,\"frameContext\":\"frame\",\"diagnostics\":true,\"tapStrategy\":\"future\",\"futureField\":true"
        ))
        XCTAssertEqual(payload.requestId, "options")
        XCTAssertEqual(payload.duration, 25)
        XCTAssertEqual(payload.doubleTap, true)
        XCTAssertEqual(payload.frameContext, "frame")
        XCTAssertEqual(payload.diagnostics, true)
        XCTAssertEqual(payload.tapStrategy, "future")
    }

    func testTapDeadlineRejectsAllModesBeforeDelivery() async throws {
        for fields in ["", ",\"doubleTap\":true", ",\"diagnostics\":true"] {
            for expiresOnMainActor in [false, true] {
                let clock = FakeMonotonicClock()
                if !expiresOnMainActor { clock.advance(by: 100) }
                let gestures = FakeGesturePerformer()
                let handler = CommandHandler(
                    elementLocator: FakeElementLocator(), gesturePerformer: gestures,
                    perf: FakePerfTracking(flushResult: nil)
                )
                let request = try JSONDecoder().decode(WebSocketRequest.self, from: tap("late", fields: fields))
                let result = await handler.handle(request, deadlineMs: 100, monotonicNowMs: {
                    let now = clock.now()
                    // Initial check: 0; beforeOperation: 50; main-actor delivery check: 100.
                    if expiresOnMainActor { clock.advance(by: 50) }
                    return now
                })
                let response = try XCTUnwrap(result as? WebSocketResponse)
                XCTAssertEqual(response.success, false)
                XCTAssertEqual(response.errorCode, "deadline_not_started")
                XCTAssertEqual(
                    response.error,
                    "Command request_tap_coordinates exceeded deadline at 100ms (gesture was not started)"
                )
                XCTAssertEqual(gestures.tapCalls, 0)
                XCTAssertEqual(gestures.diagnosticTapCalls, 0)
                XCTAssertTrue(gestures.doubleTapPoints.isEmpty)
            }
        }
    }

    func testTapDeadlineIsRecheckedAfterFrameCapture() async throws {
        let clock = FakeMonotonicClock()
        let locator = FakeElementLocator()
        locator.onCapture = { clock.advance(by: 100) }
        let gestures = FakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: gestures, perf: FakePerfTracking(flushResult: nil)
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self, from: tap("capture", fields: ",\"frameContext\":\"frame\"")
        )
        let result = await handler.handle(request, deadlineMs: 100, monotonicNowMs: { clock.now() })
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.errorCode, "deadline_not_started")
        XCTAssertEqual(gestures.tapCalls, 0)
        XCTAssertEqual(locator.filteringRequests.count, 1)
    }

    func testTapReturningAfterDeadlineOrAbandonmentReportsCompletedGesture() async throws {
        for fields in ["", ",\"doubleTap\":true", ",\"diagnostics\":true"] {
            for abandoned in [false, true] {
                let clock = FakeMonotonicClock()
                let deliveryGate = GestureDeliveryGate()
                let gestures = FakeGesturePerformer()
                gestures.onTap = {
                    if abandoned {
                        deliveryGate.abandon()
                    } else {
                        clock.advance(by: 5000)
                    }
                }
                let handler = CommandHandler(
                    elementLocator: FakeElementLocator(), gesturePerformer: gestures,
                    perf: FakePerfTracking(flushResult: nil)
                )
                let request = try JSONDecoder().decode(WebSocketRequest.self, from: tap("late", fields: fields))
                let result = await handler.handle(
                    request, deadlineMs: 5000, monotonicNowMs: { clock.now() },
                    deliveryAbandoned: { deliveryGate.abandoned }
                )
                let response = try XCTUnwrap(result as? WebSocketResponse)
                XCTAssertEqual(response.success, false)
                XCTAssertEqual(response.errorCode, "deadline_completed_late")
                XCTAssertEqual(gestures.tapCalls + gestures.diagnosticTapCalls + gestures.doubleTapPoints.count, 1)
                if abandoned { XCTAssertLessThan(clock.now(), 5000) }
            }
        }
    }

    func testSwipeReturningAfterAbandonmentReportsCompletedGestureBeforeDeadline() async throws {
        let clock = FakeMonotonicClock()
        let deliveryGate = GestureDeliveryGate()
        let gestures = FakeGesturePerformer()
        gestures.onSwipe = { deliveryGate.abandon() }
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: swipe("late"))
        let result = await handler.handle(
            request, deadlineMs: 5000, monotonicNowMs: { clock.now() },
            deliveryAbandoned: { deliveryGate.abandoned }
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.errorCode, "deadline_completed_late")
        XCTAssertEqual(gestures.swipeCalls, 1)
        XCTAssertLessThan(clock.now(), 5000)
    }

    func testTapWireBudgetReachesHandlerAndLegacyTapStillSucceeds() async throws {
        for fields in ["", ",\"timeoutMs\":5000"] {
            let clock = FakeMonotonicClock()
            let gestures = FakeGesturePerformer()
            let timer = FakeProxyTimer(mode: .manual)
            let server = server(gestures: gestures, clock: clock, timer: timer)
            let done = expectation(description: "tap response")
            let responder = CapturingResponder(onEach: { done.fulfill() })
            server.dispatchCommand(tap("wire", fields: fields), responder: responder)
            await fulfillment(of: [done], timeout: 2)
            XCTAssertEqual(gestures.tapCalls, 1)
            XCTAssertEqual(try response(responder)["success"] as? Bool, true)
            XCTAssertEqual(timer.pendingWaiterCount, 0)
        }
    }

    func testTapWireBudgetBoundsResponseAndRejectsExpiredDeliveryAfterRelease() async throws {
        let clock = FakeMonotonicClock()
        let gestures = FakeGesturePerformer()
        let timer = FakeProxyTimer(mode: .manual)
        let gate = FakeProxyTimer(mode: .manual)
        defer { gate.advance(by: 1) }
        let server = server(gestures: gestures, clock: clock, timer: timer, tapGate: gate)
        let bounded = expectation(description: "tap bound response")
        let responder = CapturingResponder(onEach: { bounded.fulfill() })
        server.dispatchCommand(tap("bound", fields: ",\"timeoutMs\":5000"), responder: responder)
        var spins = 0
        while timer.pendingWaiterCount == 0 || gate.pendingWaiterCount == 0, spins < 10000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertEqual(timer.pendingWaiterCount, 1)
        XCTAssertEqual(gate.pendingWaiterCount, 1)
        let nextDone = expectation(description: "chain released")
        let next = CapturingResponder(onEach: { nextDone.fulfill() })
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"next"}"#.utf8), responder: next)
        XCTAssertTrue(next.captured.isEmpty)
        clock.advance(by: 4499)
        timer.advance(by: 4499)
        XCTAssertTrue(responder.captured.isEmpty)
        clock.advance(by: 1)
        timer.advance(by: 1)
        await fulfillment(of: [bounded], timeout: 2)
        XCTAssertEqual(try response(responder)["errorCode"] as? String, "gesture_bound_exceeded")
        try XCTAssertTrue((response(responder)["error"] as? String)?.contains("4500ms") == true)
        XCTAssertEqual(gestures.tapCalls, 0)

        XCTAssertTrue(next.captured.isEmpty)
        clock.advance(by: 500)
        gate.advance(by: 1)
        await fulfillment(of: [nextDone], timeout: 2)
        XCTAssertEqual(gestures.tapCalls, 0)
        XCTAssertEqual(responder.captured.count, 1)
        XCTAssertEqual(try response(next)["success"] as? Bool, true)
    }

    func testTapWatchdogRejectsDeliveryBeforeDeadlineAndReleasesBusyGuard() async throws {
        try await assertWatchdogRejectsDeliveryBeforeDeadline(isTap: true)
    }

    func testSwipeWatchdogRejectsDeliveryBeforeDeadlineAndReleasesBusyGuard() async throws {
        try await assertWatchdogRejectsDeliveryBeforeDeadline(isTap: false)
    }

    private func assertWatchdogRejectsDeliveryBeforeDeadline(isTap: Bool) async throws {
        let clock = FakeMonotonicClock()
        let gestures = FakeGesturePerformer()
        let timer = FakeProxyTimer(mode: .manual)
        let gate = FakeProxyTimer(mode: .manual)
        defer { gate.advance(by: 1) }
        let server = server(
            gestures: gestures, clock: clock, timer: timer,
            tapGate: isTap ? gate : nil, swipeGate: isTap ? nil : gate
        )
        let bounded = expectation(description: "early bound response")
        let responder = CapturingResponder(onEach: { bounded.fulfill() })
        let request = isTap
            ? tap("abandoned", fields: ",\"timeoutMs\":5000")
            : swipe("abandoned", timeout: ",\"timeoutMs\":5000")
        server.dispatchCommand(request, responder: responder)
        var spins = 0
        while timer.pendingWaiterCount == 0 || gate.pendingWaiterCount == 0, spins < 10000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertEqual(timer.pendingWaiterCount, 1)
        XCTAssertEqual(gate.pendingWaiterCount, 1)
        let nextDone = expectation(description: "chain and busy guard released")
        let next = CapturingResponder(onEach: { nextDone.fulfill() })
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"next"}"#.utf8), responder: next)
        XCTAssertTrue(next.captured.isEmpty)
        clock.advance(by: 4500)
        timer.advance(by: 4500)
        await fulfillment(of: [bounded], timeout: 2)
        XCTAssertEqual(try response(responder)["errorCode"] as? String, "gesture_bound_exceeded")
        XCTAssertEqual(try response(responder)["success"] as? Bool, false)
        XCTAssertEqual(gestures.tapCalls, 0)
        XCTAssertEqual(gestures.swipeCalls, 0)

        let busy = CapturingResponder()
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"busy"}"#.utf8), responder: busy)
        XCTAssertEqual(try response(busy)["error"] as? String, "runner_busy")
        XCTAssertEqual(try response(busy)["blockingDeadlineRemainingMs"] as? Int, 500)
        XCTAssertTrue(next.captured.isEmpty)

        gate.advance(by: 1)
        await fulfillment(of: [nextDone], timeout: 2)
        XCTAssertLessThan(clock.now(), 5000)
        XCTAssertEqual(gestures.tapCalls, 0)
        XCTAssertEqual(gestures.swipeCalls, 0)
        XCTAssertEqual(responder.captured.count, 1)
        XCTAssertEqual(try response(next)["success"] as? Bool, true)

        let freshDone = expectation(description: "fresh command admitted after release")
        let fresh = CapturingResponder(onEach: { freshDone.fulfill() })
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"fresh"}"#.utf8), responder: fresh)
        await fulfillment(of: [freshDone], timeout: 2)
        XCTAssertEqual(try response(fresh)["success"] as? Bool, true)
    }

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
        gestures: FakeGesturePerformer, clock: FakeMonotonicClock,
        elementLocator: FakeElementLocator = FakeElementLocator(),
        logSink: any GestureLogSink = SystemGestureLogSink(),
        timings: [PerfTiming]? = nil,
        timer: any ProxyTimer = FakeProxyTimer(mode: .manual),
        tapGate: FakeProxyTimer? = nil,
        swipeGate: FakeProxyTimer? = nil,
        other: @escaping @Sendable (WebSocketRequest) -> any WebSocketResponsePayload = { request in
            WebSocketResponse.success(type: "screenshot", requestId: request.requestId, totalTimeMs: 0)
        }
    )
        -> WebSocketServer
    {
        WebSocketServer(
            commandHandler: DeadlineForwardingHandler(
                swipeHandler: CommandHandler(
                    elementLocator: elementLocator, gesturePerformer: gestures,
                    perf: FakePerfTracking(flushResult: nil)
                ), other: other, tapGate: tapGate, swipeGate: swipeGate
            ),
            perf: FakePerfTracking(flushResult: timings),
            frameContext: FakeFrameContextRecording(token: nil),
            busyBudgetMs: 3000,
            monotonicNowMs: { clock.now() },
            gestureLogSink: logSink,
            timer: timer
        )
    }

    func testDispatchDecisionAndBoundArePure() {
        XCTAssertEqual(swipeDispatchMode(lockScreen: nil), .xcuitest)
        XCTAssertEqual(swipeDispatchMode(lockScreen: false), .xcuitest)
        XCTAssertEqual(swipeDispatchMode(lockScreen: true), .synthesizedLockScreen)
        XCTAssertNil(gestureExecutionBoundMs(deadlineMs: nil, executionStartedAtMs: 1000))
        XCTAssertEqual(gestureExecutionBoundMs(deadlineMs: 6000, executionStartedAtMs: 1000), 4500)
        XCTAssertEqual(gestureExecutionBoundMs(deadlineMs: 1100, executionStartedAtMs: 1000), 250)
        XCTAssertEqual(gestureExecutionBoundMs(deadlineMs: 900, executionStartedAtMs: 1000), 250)
    }

    func testLockScreenFlagDecodeAndRouting() async throws {
        for (field, expected) in [("", nil), (",\"lockScreen\":true", true), (",\"lockScreen\":false", false)] {
            let data = swipe("flag", timeout: field)
            let request = try JSONDecoder().decode(RequestSwipe.self, from: data)
            XCTAssertEqual(request.lockScreen, expected)
            let legacy = try JSONDecoder().decode(LegacySwipePayload.self, from: data)
            XCTAssertEqual(
                [legacy.x1, legacy.y1, legacy.x2, legacy.y2],
                [request.x1, request.y1, request.x2, request.y2]
            )
            let gestures = FakeGesturePerformer()
            let done = expectation(description: "routed swipe")
            let responder = CapturingResponder(onEach: { done.fulfill() })
            let server = server(gestures: gestures, clock: FakeMonotonicClock())
            server.dispatchCommand(data, responder: responder)
            await fulfillment(of: [done], timeout: 2)
            XCTAssertEqual(gestures.swipeCalls, expected == true ? 0 : 1)
            XCTAssertEqual(gestures.lockScreenSwipeCalls, expected == true ? 1 : 0)
            XCTAssertEqual(try response(responder)["success"] as? Bool, true)
        }
        // Unknown fields remain ignorable; older runners decode the same envelope.
        XCTAssertNil(
            try JSONDecoder().decode(RequestSwipe.self, from: swipe("extra", timeout: ",\"futureField\":true"))
                .lockScreen
        )
        for invalid in ["1", "\"true\"", "{}", "[]"] {
            XCTAssertThrowsError(try JSONDecoder().decode(
                RequestSwipe.self,
                from: swipe("bad", timeout: ",\"lockScreen\":\(invalid)")
            ))
        }
    }

    func testSwipeHandlerAnnotatesCachedTrackerAndDispatchOnBoundAndFinalLines() async throws {
        for field in ["", ",\"lockScreen\":false", ",\"lockScreen\":true"] {
            let synthesized = field.contains("true")
            let clock = FakeMonotonicClock()
            let sink = FakeGestureLogSink()
            let locator = FakeElementLocator()
            locator.foregroundBundleId = "com.test.playground"
            let gestures = FakeGesturePerformer()
            gestures.onSwipe = {
                GesturePhaseDiagnostics.current?.begin(synthesized ? "synthesizedGesture" : "xcuitestGesture")
                clock.advance(by: 250)
                GesturePhaseDiagnostics.current?.markBoundExceeded(boundMs: 250)
                GesturePhaseDiagnostics.current?.begin("postGesture")
            }
            let server = server(gestures: gestures, clock: clock, elementLocator: locator, logSink: sink)
            let done = expectation(description: "annotated swipe")
            let responder = CapturingResponder(onEach: { done.fulfill() })
            server.dispatchCommand(swipe("annotations", timeout: field), responder: responder)
            await fulfillment(of: [done], timeout: 2)
            XCTAssertEqual(try response(responder)["success"] as? Bool, true)
            XCTAssertEqual(sink.lines.count, 2)
            let dispatch = synthesized ? "synthesizedLockScreen" : "xcuitest"
            for line in sink.lines {
                XCTAssertTrue(
                    line
                        .contains(
                            " dispatch=\(dispatch) trackedApp=com.test.playground xcuitestEntered=\(!synthesized)"
                        )
                )
            }
            XCTAssertTrue(sink.lines[0].contains("boundHit=true"))
            XCTAssertTrue(sink.lines[1].contains("totalMs=250"))
        }
    }

    func testHandlerWinsCancelsWatchdogAndKeepsResponseShape() async throws {
        let timer = FakeProxyTimer(mode: .manual)
        let sink = FakeGestureLogSink()
        let server = server(
            gestures: FakeGesturePerformer(),
            clock: FakeMonotonicClock(),
            logSink: sink,
            timer: timer
        )
        let done = expectation(description: "fast swipe")
        let responder = CapturingResponder(onEach: { done.fulfill() })
        server.dispatchCommand(swipe("fast", timeout: ",\"timeoutMs\":5000"), responder: responder)
        await fulfillment(of: [done], timeout: 2)
        // Cancellation can precede the watchdog starting. Let its cancellation-aware
        // wait observe it before inspecting the fake, without delaying the real response.
        var spins = 0
        while timer.cancelledWaitCount == 0, spins < 10000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertEqual(timer.cancelledWaitCount, 1)
        XCTAssertEqual(timer.pendingWaiterCount, 0)
        timer.advance(by: 5000)
        XCTAssertEqual(responder.captured.count, 1)
        XCTAssertEqual(sink.lines.count, 0)
        XCTAssertEqual(
            try Set(response(responder).keys),
            Set(["type", "timestamp", "requestId", "success", "totalTimeMs"])
        )
    }

    // This test must stay off the main actor: the fake deliberately blocks it exactly
    // like synchronous XCUITest. All test clock advancement/response inspection is off-main.
    nonisolated func testWatchdogRespondsWhileMainActorStalledAndRetainsChain() async throws {
        let timer = FakeProxyTimer(mode: .manual)
        let clock = FakeMonotonicClock()
        let sink = FakeGestureLogSink()
        let coordinator = CommandFailureCoordinator()
        let started = XCTestExpectation(description: "gesture started")
        let bounded = XCTestExpectation(description: "bound response")
        let queuedDone = XCTestExpectation(description: "queued command after release")
        let nextDone = XCTestExpectation(description: "next command")
        let release = DispatchSemaphore(value: 0)
        let server = await MainActor.run {
            let gestures = FakeGesturePerformer()
            gestures.onSwipe = {
                GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                started.fulfill()
                release.wait()
                GesturePhaseDiagnostics.current?.begin("postGesture")
            }
            return WebSocketServer(
                commandHandler: DeadlineForwardingHandler(
                    swipeHandler: CommandHandler(
                        elementLocator: FakeElementLocator(),
                        gesturePerformer: gestures,
                        perf: FakePerfTracking(flushResult: nil)
                    ),
                    other: { request in
                        WebSocketResponse.success(type: "screenshot", requestId: request.requestId, totalTimeMs: 0)
                    }
                ), perf: FakePerfTracking(flushResult: nil), frameContext: FakeFrameContextRecording(token: nil),
                failureCoordinator: coordinator, monotonicNowMs: { clock.now() }, gestureLogSink: sink, timer: timer
            )
        }
        defer { release.signal() }
        let responder = CapturingResponder(onEach: {
            XCTAssertFalse(Thread.isMainThread, "timeout must be sent while the main thread is blocked")
            bounded.fulfill()
        })
        let queued = CapturingResponder(onEach: { queuedDone.fulfill() })
        let busy = CapturingResponder()
        let next = CapturingResponder(onEach: { nextDone.fulfill() })
        server.dispatchCommand(
            Data(#"{"type":"request_swipe","requestId":"stuck","x1":1,"y1":2,"x2":3,"y2":4,"timeoutMs":5000}"#.utf8),
            responder: responder
        )
        await fulfillment(of: [started], timeout: 2)
        var spins = 0
        while timer.pendingWaiterCount == 0, spins < 10000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertEqual(timer.pendingWaiterCount, 1)
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"queued"}"#.utf8), responder: queued)
        XCTAssertTrue(queued.captured.isEmpty)
        clock.advance(by: 4499)
        timer.advance(by: 4499)
        XCTAssertTrue(responder.captured.isEmpty)
        clock.advance(by: 1)
        timer.advance(by: 1)
        await fulfillment(of: [bounded], timeout: 2)
        let result = try JSONDecoder().decode(WebSocketResponse.self, from: XCTUnwrap(responder.captured.first))
        XCTAssertEqual(result.type, "swipe_result")
        XCTAssertEqual(result.requestId, "stuck")
        XCTAssertEqual(result.success, false)
        // The gesture may still land, so the host must read this as outcome-unknown (#10016).
        XCTAssertEqual(result.errorCode, "gesture_bound_exceeded")
        XCTAssertTrue(result.error?.contains("xcuitestGesture") == true)
        XCTAssertTrue(result.error?.contains("4500ms") == true)
        XCTAssertTrue(result.error?.contains("still executing") == true)
        XCTAssertTrue(result.error?.contains("runner stays busy") == true)
        XCTAssertEqual(sink.lines.count, 1)
        XCTAssertTrue(sink.lines[0].contains("boundHit=true phaseAtBound=xcuitestGesture"))
        XCTAssertTrue(coordinator.recordDeflectedFailure("late failure"))
        XCTAssertTrue(queued.captured.isEmpty)
        clock.advance(by: 6000)
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"busy"}"#.utf8), responder: busy)
        let busyResponse = try JSONDecoder().decode(WebSocketResponse.self, from: XCTUnwrap(busy.captured.first))
        XCTAssertEqual(busyResponse.error, "runner_busy")
        XCTAssertEqual(busyResponse.blockingCommandType, "request_swipe")
        XCTAssertEqual(busyResponse.blockingElapsedMs, 10500)
        release.signal()
        await fulfillment(of: [queuedDone], timeout: 2)
        XCTAssertEqual(responder.captured.count, 1) // late deadlineExceeded is discarded
        XCTAssertEqual(sink.lines.count, 2)
        XCTAssertTrue(sink.lines[1].contains("xcuitestGestureMs=10500"))
        XCTAssertTrue(sink.lines[1].contains("phaseAtBound=xcuitestGesture"))
        XCTAssertFalse(coordinator.recordDeflectedFailure("after completion"))
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"next"}"#.utf8), responder: next)
        await fulfillment(of: [nextDone], timeout: 2)
        XCTAssertEqual(responder.captured.count, 1)
    }

    func testSwipeWithoutTimeoutKeepsLegacySuccessShape() async throws {
        let clock = FakeMonotonicClock()
        let gestures = FakeGesturePerformer()
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
        let gestures = FakeGesturePerformer()
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
        XCTAssertEqual(timeout["errorCode"] as? String, "deadline_not_started")

        clock.advance(by: 4000)
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"next"}"#.utf8), responder: next)
        await fulfillment(of: [nextDone], timeout: 2)
        XCTAssertEqual(try response(next)["success"] as? Bool, true)
        XCTAssertNil(try response(next)["error"])
    }

    func testSwipeReturningAfterDeadlineReportsIndeterminateOutcomeAndReleasesGuard() async throws {
        let clock = FakeMonotonicClock()
        let gestures = FakeGesturePerformer()
        let sink = FakeGestureLogSink()
        gestures.onSwipe = {
            GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
            clock.advance(by: 6000)
            GesturePhaseDiagnostics.current?.begin("postGesture")
        }
        let server = server(
            gestures: gestures,
            clock: clock,
            logSink: sink,
            timings: [.timing("handleRequest:request_swipe", durationMs: 6000)]
        )
        let swipeDone = expectation(description: "late swipe response")
        let nextDone = expectation(description: "next response")
        let swipeResponder = CapturingResponder(onEach: { swipeDone.fulfill() })
        let next = CapturingResponder(onEach: { nextDone.fulfill() })

        server.dispatchCommand(swipe("late", timeout: ",\"timeoutMs\":5000"), responder: swipeResponder)
        await fulfillment(of: [swipeDone], timeout: 2)
        XCTAssertEqual(gestures.swipeCalls, 1)
        XCTAssertEqual(sink.lines.count, 1)
        XCTAssertTrue(sink.lines[0].contains("xcuitestGestureMs=6000"))
        let encoded = try XCTUnwrap(swipeResponder.captured.first)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: encoded)
        XCTAssertEqual(decoded.perfTiming?.children?.last?.name, "gesturePhases")
        XCTAssertEqual(decoded.perfTiming?.children?.last?.durationMs, 6000)
        XCTAssertEqual(try response(swipeResponder)["success"] as? Bool, false)
        XCTAssertEqual(
            try response(swipeResponder)["error"] as? String,
            "Command request_swipe exceeded deadline at 5000ms (gesture completed after its deadline; outcome is indeterminate)"
        )
        XCTAssertEqual(try response(swipeResponder)["errorCode"] as? String, "deadline_completed_late")

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
        let gestures = FakeGesturePerformer()
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
