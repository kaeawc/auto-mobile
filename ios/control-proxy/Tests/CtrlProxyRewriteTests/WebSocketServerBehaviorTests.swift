@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

/// Behavioral tests for the queue-confined `WebSocketServer` orchestration, driven
/// through its seams (fake `CommandHandling` / `PerfTracking` / `FrameContextRecording`,
/// a capturing responder, and the broadcast sink) — no live socket. The wire bytes
/// the server emits come from already-parity-verified components (response models,
/// `ErrorResponse`, `WebSocketFraming`), so these verify the server's own logic:
/// command offload, perfTiming injection, decode-failure handling, presence
/// transitions, and broadcast.
final class WebSocketServerBehaviorTests: XCTestCase {
    private func decodeObject(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - dispatch → handle → encode → send

    func testDefaultBusyBudgetIsTenSeconds() {
        XCTAssertEqual(WebSocketServer.defaultBusyBudgetMs, 10000)
    }

    func testAdmissionDecisionUsesElapsedInFlightTime() {
        XCTAssertEqual(admissionDecision(inFlight: nil, nowMs: 5000, budgetMs: 3000), .queue)
        let inFlight = InFlightRunnerCommand(
            type: "request_set_text", requestId: "blocker", startedAtMs: 1000, deadlineMs: nil
        )
        XCTAssertEqual(admissionDecision(inFlight: inFlight, nowMs: 4000, budgetMs: 3000), .queue)
        XCTAssertEqual(
            admissionDecision(inFlight: inFlight, nowMs: 4001, budgetMs: 3000),
            .busy(blockingType: "request_set_text", elapsedMs: 3001, deadlineRemainingMs: nil)
        )
    }

    func testAdmissionDecisionReportsSignedDeadlineRemaining() {
        let inFlight = InFlightRunnerCommand(
            type: "request_swipe", requestId: "swipe", startedAtMs: 1000, deadlineMs: 6000
        )
        XCTAssertEqual(
            admissionDecision(inFlight: inFlight, nowMs: 7000, budgetMs: 3000),
            .busy(blockingType: "request_swipe", elapsedMs: 6000, deadlineRemainingMs: -1000)
        )
    }

    func testBlockedPerformerRejectsNewCommandBeforeItCanQueue() {
        let started = expectation(description: "blocking performer started")
        let busy = expectation(description: "queued request rejected promptly")
        let finished = expectation(description: "blocking performer finished")
        let release = DispatchSemaphore(value: 0)
        let clock = FakeMonotonicClock()
        let blocker = CapturingResponder(onEach: { finished.fulfill() })
        let newcomer = CapturingResponder(onEach: { busy.fulfill() })
        let server = makeTestServer(
            handler: { request in
                started.fulfill()
                release.wait()
                return WebSocketResponse.success(type: "set_text_result", requestId: request.requestId, totalTimeMs: 0)
            },
            busyBudgetMs: 3000,
            monotonicNowMs: { clock.now() }
        )

        server.dispatchCommand(
            Data(#"{"type":"request_set_text","requestId":"blocker","text":"hello"}"#.utf8),
            responder: blocker
        )
        wait(for: [started], timeout: 2)
        clock.advance(by: 3100)
        server.dispatchCommand(
            Data(#"{"type":"request_hierarchy","requestId":"waiting"}"#.utf8),
            responder: newcomer
        )
        wait(for: [busy], timeout: 1)
        let response = decodeObject(newcomer.captured[0])
        XCTAssertEqual(response?["requestId"] as? String, "waiting")
        XCTAssertEqual(response?["error"] as? String, "runner_busy")
        XCTAssertEqual(response?["blockingCommandType"] as? String, "request_set_text")
        XCTAssertEqual(response?["blockingElapsedMs"] as? Int, 3100)
        XCTAssertNil(response?["blockingDeadlineRemainingMs"])
        XCTAssertTrue(blocker.captured.isEmpty, "the blocking command has not finished")
        release.signal()
        wait(for: [finished], timeout: 2)
    }

    func testCommandUnderBudgetKeepsSerialOrdering() {
        let started = expectation(description: "first performer started")
        let firstFinished = expectation(description: "first response")
        let secondFinished = expectation(description: "second response")
        let release = DispatchSemaphore(value: 0)
        let clock = FakeMonotonicClock()
        let first = CapturingResponder(onEach: { firstFinished.fulfill() })
        let second = CapturingResponder(onEach: { secondFinished.fulfill() })
        let server = makeTestServer(
            handler: { request in
                if request.requestId == "first" {
                    started.fulfill()
                    release.wait()
                }
                return WebSocketResponse.success(type: "screenshot", requestId: request.requestId, totalTimeMs: 0)
            },
            busyBudgetMs: 3000,
            monotonicNowMs: { clock.now() }
        )

        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"first"}"#.utf8), responder: first)
        wait(for: [started], timeout: 2)
        clock.advance(by: 3000)
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"second"}"#.utf8), responder: second)
        XCTAssertTrue(second.captured.isEmpty)
        release.signal()
        wait(for: [firstFinished, secondFinished], timeout: 2, enforceOrder: true)
        XCTAssertEqual(decodeObject(second.captured[0])?["success"] as? Bool, true)
    }

    // MARK: - Queued command start gate (#10084)

    func testCommandExpiryUsesOptionalPositiveWireTimeout() {
        XCTAssertEqual(commandExpiryMs(timeoutMs: 5000, receivedAtMs: 1000), 6000)
        XCTAssertNil(commandExpiryMs(timeoutMs: nil, receivedAtMs: 1000))
        XCTAssertNil(commandExpiryMs(timeoutMs: 0, receivedAtMs: 1000))
        XCTAssertNil(commandExpiryMs(timeoutMs: -5, receivedAtMs: 1000))
        XCTAssertEqual(commandExpiryMs(timeoutMs: Int64.max, receivedAtMs: 1000), Int64.max)
    }

    func testQueuedCommandDispositionRunsDropsExpiredAndClosed() {
        XCTAssertEqual(queuedCommandDisposition(expiresAtMs: nil, nowMs: 9_000_000, isConnectionOpen: true), .run)
        XCTAssertEqual(queuedCommandDisposition(expiresAtMs: 6000, nowMs: 5999, isConnectionOpen: true), .run)
        XCTAssertEqual(
            queuedCommandDisposition(expiresAtMs: 6000, nowMs: 6000, isConnectionOpen: true),
            .expired(expiresAtMs: 6000)
        )
        XCTAssertEqual(
            queuedCommandDisposition(expiresAtMs: nil, nowMs: 0, isConnectionOpen: false), .connectionClosed
        )
        XCTAssertEqual(
            queuedCommandDisposition(expiresAtMs: 6000, nowMs: 7000, isConnectionOpen: false), .connectionClosed
        )
    }

    func testQueuedCommandPastItsWireDeadlineIsNotExecutedAndGetsDeadlineError() {
        let started = expectation(description: "blocking performer started")
        let blockerDone = expectation(description: "blocker response")
        let dropped = expectation(description: "expired command answered")
        let release = DispatchSemaphore(value: 0)
        let clock = FakeMonotonicClock()
        let handled = ValueBox<String>()
        let blocker = CapturingResponder(onEach: { blockerDone.fulfill() })
        let queued = CapturingResponder(onEach: { dropped.fulfill() })
        let server = makeTestServer(
            handler: { request in
                handled.append(request.requestId ?? "nil")
                if request.requestId == "blocker" {
                    started.fulfill()
                    release.wait()
                }
                return WebSocketResponse.success(type: "set_text_result", requestId: request.requestId, totalTimeMs: 0)
            },
            monotonicNowMs: { clock.now() }
        )

        server.dispatchCommand(
            Data(#"{"type":"request_set_text","requestId":"blocker","text":"hello"}"#.utf8), responder: blocker
        )
        wait(for: [started], timeout: 2)
        clock.advance(by: 1000)
        server.dispatchCommand(
            Data(#"{"type":"request_rotate","requestId":"rotate","orientation":"landscape","timeoutMs":5000}"#.utf8), responder: queued
        )
        clock.advance(by: 7000)
        release.signal()
        wait(for: [blockerDone, dropped], timeout: 2)

        XCTAssertEqual(handled.values, ["blocker"], "the expired rotate must never reach the handler")
        let response = decodeObject(queued.captured[0])
        XCTAssertEqual(response?["requestId"] as? String, "rotate")
        XCTAssertEqual(response?["success"] as? Bool, false)
        XCTAssertTrue((response?["error"] as? String ?? "").contains("gesture was not started"))
    }

    func testQueuedCommandWithoutWireTimeoutStillRunsAfterALongWait() {
        let started = expectation(description: "blocking performer started")
        let secondDone = expectation(description: "legacy command answered")
        let release = DispatchSemaphore(value: 0)
        let clock = FakeMonotonicClock()
        let handled = ValueBox<String>()
        let second = CapturingResponder(onEach: { secondDone.fulfill() })
        let server = makeTestServer(
            handler: { request in
                handled.append(request.requestId ?? "nil")
                if request.requestId == "blocker" {
                    started.fulfill()
                    release.wait()
                }
                return WebSocketResponse.success(type: "set_text_result", requestId: request.requestId, totalTimeMs: 0)
            },
            monotonicNowMs: { clock.now() }
        )

        server.dispatchCommand(
            Data(#"{"type":"request_set_text","requestId":"blocker","text":"hello"}"#.utf8),
            responder: CapturingResponder()
        )
        wait(for: [started], timeout: 2)
        clock.advance(by: 1000)
        server.dispatchCommand(Data(#"{"type":"request_rotate","requestId":"legacy","orientation":"landscape"}"#.utf8), responder: second)
        clock.advance(by: 7000)
        release.signal()
        wait(for: [secondDone], timeout: 2)

        XCTAssertEqual(handled.values, ["blocker", "legacy"])
    }

    func testQueuedCommandIsNotExecutedWhenItsConnectionClosedWhileWaiting() {
        let started = expectation(description: "blocking performer started")
        let blockerDone = expectation(description: "blocker response")
        let release = DispatchSemaphore(value: 0)
        let handled = ValueBox<String>()
        let open = OSAllocatedUnfairLock(initialState: true)
        let queued = CapturingResponder()
        let server = makeTestServer(handler: { request in
            handled.append(request.requestId ?? "nil")
            if request.requestId == "blocker" {
                started.fulfill()
                release.wait()
            }
            return WebSocketResponse.success(type: "set_text_result", requestId: request.requestId, totalTimeMs: 0)
        })

        server.dispatchCommand(
            Data(#"{"type":"request_set_text","requestId":"blocker","text":"hello"}"#.utf8),
            responder: CapturingResponder(onEach: { blockerDone.fulfill() })
        )
        wait(for: [started], timeout: 2)
        server.dispatchCommand(
            Data(#"{"type":"request_press_button","requestId":"press","action":"home","timeoutMs":5000}"#.utf8),
            responder: queued, isConnectionOpen: { open.withLock { $0 } }
        )
        open.withLock { $0 = false }
        release.signal()
        wait(for: [blockerDone], timeout: 2)
        // A follow-up command on the same chain only runs after the dropped one was skipped.
        let followUpDone = expectation(description: "follow-up response")
        server.dispatchCommand(
            Data(#"{"type":"request_rotate","requestId":"after","orientation":"landscape"}"#.utf8),
            responder: CapturingResponder(onEach: { followUpDone.fulfill() })
        )
        wait(for: [followUpDone], timeout: 2)

        XCTAssertEqual(handled.values, ["blocker", "after"])
        XCTAssertTrue(queued.captured.isEmpty, "nothing is written to a closed connection")
    }

    func testDispatchCommandEncodesAndSendsResponse() {
        let exp = expectation(description: "response sent")
        let responder = CapturingResponder(onEach: { exp.fulfill() })
        let server = makeTestServer(handler: { request in
            WebSocketResponse.success(type: "screenshot", requestId: request.requestId, totalTimeMs: 7)
        })

        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"r1"}"#.utf8), responder: responder)
        wait(for: [exp], timeout: 2)

        let object = decodeObject(responder.captured[0])
        XCTAssertEqual(object?["type"] as? String, "screenshot")
        XCTAssertEqual(object?["requestId"] as? String, "r1")
        XCTAssertEqual(object?["success"] as? Bool, true)
    }

    func testDecodeFailureSendsStructuredError() {
        let exp = expectation(description: "error sent")
        let responder = CapturingResponder(onEach: { exp.fulfill() })
        let server = makeTestServer() // handler never invoked on the decode-failure path

        server.dispatchCommand(Data(#"{"type":"totally_bogus_command","requestId":"r2"}"#.utf8), responder: responder)
        wait(for: [exp], timeout: 2)

        let object = decodeObject(responder.captured[0])
        XCTAssertEqual(object?["type"] as? String, "error")
        XCTAssertEqual(object?["success"] as? Bool, false)
        XCTAssertEqual(object?["requestId"] as? String, "r2", "requestId recovered from raw JSON")
        XCTAssertEqual(object?["error"] as? String, "Unknown command type: totally_bogus_command")
    }

    func testPerfTimingInjectedIntoResponse() {
        let exp = expectation(description: "response sent")
        let responder = CapturingResponder(onEach: { exp.fulfill() })
        let server = makeTestServer(
            handler: { request in
                // A WebSocketResponse without its own perfTiming.
                WebSocketResponse.success(type: "tap_coordinates_result", requestId: request.requestId, totalTimeMs: 3)
            },
            flush: [PerfTiming(name: "handleRequest", durationMs: 12)]
        )

        server.dispatchCommand(
            Data(#"{"type":"request_tap_coordinates","requestId":"r3","x":1,"y":2}"#.utf8),
            responder: responder
        )
        wait(for: [exp], timeout: 2)

        let object = decodeObject(responder.captured[0])
        let perf = object?["perfTiming"] as? [String: Any]
        XCTAssertEqual(perf?["name"] as? String, "handleRequest", "server should inject flushed perfTiming")
        XCTAssertEqual(perf?["durationMs"] as? Int, 12)
    }

    // MARK: - Presence transitions

    func testPresenceFiresOnlyOnZeroToNonZeroAndBack() {
        let transitions = ValueBox<Bool>()
        let server = makeTestServer(onPresence: { transitions.append($0) })

        server.clientDidUpgrade(1)
        server.clientDidUpgrade(2) // still non-empty → no second `true`
        XCTAssertTrue(server.hasConnectedClients)
        server.clientDidDisconnect(1) // still one left → no `false`
        server.clientDidDisconnect(2) // now empty → `false`
        XCTAssertFalse(server.hasConnectedClients)

        XCTAssertEqual(transitions.values, [true, false], "presence toggles only on 0↔N transitions")
    }

    func testStopClearsPresenceBeforeNextConnection() {
        let transitions = ValueBox<Bool>()
        let server = makeTestServer(onPresence: { transitions.append($0) })
        server.clientDidUpgrade(1)
        server.stop()
        XCTAssertFalse(server.hasConnectedClients)
        server.clientDidUpgrade(2)
        XCTAssertTrue(server.hasConnectedClients)
        XCTAssertEqual(transitions.values, [true, false, true])
        server.stop()
    }

    func testHttpOnlyDisconnectNeverTogglesPresence() {
        let transitions = ValueBox<Bool>()
        let server = makeTestServer(onPresence: { transitions.append($0) })
        // A never-upgraded (HTTP-only) connection closing is a no-op for presence.
        server.clientDidDisconnect(99)
        XCTAssertEqual(transitions.values, [])
        XCTAssertFalse(server.hasConnectedClients)
    }

    // MARK: - Broadcast

    func testBroadcastRoutesToSink() {
        let captured = ValueBox<Data>()
        let server = makeTestServer(broadcastSink: { captured.append($0) })
        let payload = Data("hello".utf8)
        server.broadcast(payload)
        XCTAssertEqual(captured.values, [payload])
    }

    /// Broadcasts route only to connections that completed the RFC 6455 upgrade —
    /// never to HTTP-only probes that share the accept path (#5830). Drives the live
    /// loop (no `broadcastSink`) via the upgraded-responder seam.
    func testBroadcastSendsOnlyToUpgradedResponders() {
        let server = makeTestServer()
        let upgraded = CapturingResponder()
        server.registerUpgradedResponderForTesting(upgraded, id: 7)

        server.broadcast(Data("PUSH".utf8))
        XCTAssertEqual(upgraded.captured, [Data("PUSH".utf8)], "broadcast must reach upgraded responders")

        // After disconnect the responder leaves the broadcast-eligible set.
        server.clientDidDisconnect(7)
        server.broadcast(Data("AGAIN".utf8))
        XCTAssertEqual(
            upgraded.captured, [Data("PUSH".utf8)],
            "a disconnected responder must receive no further broadcasts"
        )
    }

    func testBroadcastHierarchyUpdateStampsFrameContext() {
        let captured = ValueBox<Data>()
        let server = makeTestServer(frameToken: "epoch:1:abc", broadcastSink: { captured.append($0) })
        server.broadcastHierarchyUpdate(ViewHierarchy(packageName: "com.example.app"))

        let object = decodeObject(captured.values[0])
        XCTAssertEqual(object?["type"] as? String, "hierarchy_update")
        XCTAssertEqual(object?["frameContext"] as? String, "epoch:1:abc")
        XCTAssertNil(object?["requestId"], "push updates carry no requestId")
        XCTAssertNotNil(object?["data"], "hierarchy payload present")
    }
}
