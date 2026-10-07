@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

/// A command queued behind a slow one is dropped, unstarted, once its sender stopped waiting:
/// its wire deadline passed or its connection closed (#10084).
final class QueuedCommandDeadlineTests: XCTestCase {
    private func decodeObject(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func rotate(_ id: String, timeout: String = "") -> Data {
        Data(#"{"type":"request_rotate","requestId":"\#(id)","orientation":"landscape"\#(timeout)}"#.utf8)
    }

    /// A server whose handler blocks the request with id "blocker" until `release` is signalled
    /// and records the id of every request it actually executes.
    private func blockingServer(
        clock: FakeMonotonicClock, started: XCTestExpectation, release: DispatchSemaphore,
        handled: OSAllocatedUnfairLock<[String]>
    )
        -> WebSocketServer
    {
        makeTestServer(
            handler: { request in
                handled.withLock { $0.append(request.requestId ?? "nil") }
                if request.requestId == "blocker" {
                    started.fulfill()
                    release.wait()
                }
                return WebSocketResponse.success(type: "rotate_result", requestId: request.requestId, totalTimeMs: 0)
            },
            monotonicNowMs: { clock.now() }
        )
    }

    // MARK: - Pure rules

    func testDispositionExecutesUntilTheDeadlineAndPrefersClosedConnection() {
        XCTAssertEqual(
            queuedCommandDisposition(connectionOpen: true, deadlineMs: nil, receivedAtMs: 0, nowMs: 99999),
            .execute
        )
        XCTAssertEqual(
            queuedCommandDisposition(connectionOpen: true, deadlineMs: 5000, receivedAtMs: 0, nowMs: 4999),
            .execute
        )
        XCTAssertEqual(
            queuedCommandDisposition(connectionOpen: true, deadlineMs: 6000, receivedAtMs: 1000, nowMs: 8000),
            .expired(queuedMs: 7000, timeoutMs: 5000)
        )
        XCTAssertEqual(
            queuedCommandDisposition(connectionOpen: false, deadlineMs: nil, receivedAtMs: 0, nowMs: 0),
            .connectionClosed
        )
    }

    func testEnvelopeDeadlineAcceptsOnlyPositiveIntegerTimeout() {
        for (field, expected) in [
            (",\"timeoutMs\":5000", Int64(6000)),
            ("", nil),
            (",\"timeoutMs\":0", nil),
            (",\"timeoutMs\":-1", nil),
            (",\"timeoutMs\":\"5000\"", nil),
            (",\"timeoutMs\":true", nil),
            (",\"timeoutMs\":5.5", nil),
        ] {
            XCTAssertEqual(
                CommandDeadlineEnvelope.deadlineMs(from: rotate("d", timeout: field), receivedAtMs: 1000),
                expected, field
            )
        }
        XCTAssertEqual(
            CommandDeadlineEnvelope.deadlineMs(from: rotate("d", timeout: ",\"timeoutMs\":5000"), receivedAtMs: .max),
            .max
        )
    }

    // MARK: - Server queue

    func testQueuedCommandPastItsDeadlineIsNeverStartedAndGetsTypedError() {
        let clock = FakeMonotonicClock()
        let started = expectation(description: "blocker started")
        let blockerDone = expectation(description: "blocker response")
        let expiredDone = expectation(description: "expired response")
        let nextDone = expectation(description: "next response")
        let release = DispatchSemaphore(value: 0)
        let handled = OSAllocatedUnfairLock<[String]>(initialState: [])
        let server = blockingServer(clock: clock, started: started, release: release, handled: handled)
        let blocker = CapturingResponder(onEach: { blockerDone.fulfill() })
        let expired = CapturingResponder(onEach: { expiredDone.fulfill() })
        let next = CapturingResponder(onEach: { nextDone.fulfill() })

        server.dispatchCommand(rotate("blocker"), responder: blocker)
        wait(for: [started], timeout: 2)
        clock.advance(by: 1000)
        server.dispatchCommand(rotate("queued", timeout: ",\"timeoutMs\":5000"), responder: expired)
        clock.advance(by: 7000)
        release.signal()
        wait(for: [blockerDone, expiredDone], timeout: 2)

        XCTAssertEqual(handled.withLock { $0 }, ["blocker"])
        let response = decodeObject(expired.captured[0])
        XCTAssertEqual(response?["type"] as? String, "rotate_result")
        XCTAssertEqual(response?["requestId"] as? String, "queued")
        XCTAssertEqual(response?["success"] as? Bool, false)
        XCTAssertEqual(
            response?["error"] as? String,
            "Command request_rotate expired before execution: it waited 7000ms in the runner queue, past its 5000ms deadline; the command was not started"
        )

        // The busy guard was never taken by the dropped command: the next one runs normally.
        server.dispatchCommand(rotate("next", timeout: ",\"timeoutMs\":5000"), responder: next)
        wait(for: [nextDone], timeout: 2)
        XCTAssertEqual(decodeObject(next.captured[0])?["success"] as? Bool, true)
        XCTAssertEqual(handled.withLock { $0 }, ["blocker", "next"])
    }

    func testQueuedCommandWithoutDeadlineKeepsLegacyBehaviour() {
        let clock = FakeMonotonicClock()
        let started = expectation(description: "blocker started")
        let blockerDone = expectation(description: "blocker response")
        let legacyDone = expectation(description: "legacy response")
        let release = DispatchSemaphore(value: 0)
        let handled = OSAllocatedUnfairLock<[String]>(initialState: [])
        let server = blockingServer(clock: clock, started: started, release: release, handled: handled)
        let blocker = CapturingResponder(onEach: { blockerDone.fulfill() })
        let legacy = CapturingResponder(onEach: { legacyDone.fulfill() })

        server.dispatchCommand(rotate("blocker"), responder: blocker)
        wait(for: [started], timeout: 2)
        server.dispatchCommand(rotate("legacy"), responder: legacy)
        clock.advance(by: 9000)
        release.signal()
        wait(for: [blockerDone, legacyDone], timeout: 2, enforceOrder: true)

        XCTAssertEqual(handled.withLock { $0 }, ["blocker", "legacy"])
        XCTAssertEqual(decodeObject(legacy.captured[0])?["success"] as? Bool, true)
    }

    func testQueuedCommandWhoseConnectionClosedIsDroppedWithoutReply() {
        let clock = FakeMonotonicClock()
        let started = expectation(description: "blocker started")
        let blockerDone = expectation(description: "blocker response")
        let nextDone = expectation(description: "next response")
        let release = DispatchSemaphore(value: 0)
        let handled = OSAllocatedUnfairLock<[String]>(initialState: [])
        let connectionOpen = OSAllocatedUnfairLock(initialState: true)
        let server = blockingServer(clock: clock, started: started, release: release, handled: handled)
        let blocker = CapturingResponder(onEach: { blockerDone.fulfill() })
        let orphan = CapturingResponder()
        let next = CapturingResponder(onEach: { nextDone.fulfill() })

        server.dispatchCommand(rotate("blocker"), responder: blocker)
        wait(for: [started], timeout: 2)
        server.dispatchCommand(
            rotate("orphan", timeout: ",\"timeoutMs\":5000"), responder: orphan,
            isConnectionOpen: { connectionOpen.withLock { $0 } }
        )
        connectionOpen.withLock { $0 = false }
        release.signal()
        wait(for: [blockerDone], timeout: 2)
        // Commands run strictly in order, so once `next` answers the orphan was already processed.
        server.dispatchCommand(rotate("next"), responder: next)
        wait(for: [nextDone], timeout: 2)

        XCTAssertEqual(handled.withLock { $0 }, ["blocker", "next"])
        XCTAssertTrue(orphan.captured.isEmpty)
    }
}
