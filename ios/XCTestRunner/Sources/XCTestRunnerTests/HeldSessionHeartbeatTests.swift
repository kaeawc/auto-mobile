import XCTest
@testable import XCTestRunner

/// The held-session heartbeat loop must notice a released session (#11102) instead of
/// heartbeating a terminal UUID forever.
final class HeldSessionHeartbeatTests: XCTestCase {
    func testClassifiesReleasedSessionReply() {
        let reply: [String: Any] = [
            "success": false, "error": "Session not found: s1",
            "code": "daemon_session_not_found", "releaseReason": "idle",
        ]
        XCTAssertEqual(
            HeldSessionLoss.lostReason(in: reply, sessionId: "s1"),
            "the daemon released session s1 (idle)"
        )
    }

    func testUnknownSessionWithoutReasonStillCountsAsLost() {
        let reply: [String: Any] = ["success": false, "error": "Session not found: s1"]
        XCTAssertEqual(
            HeldSessionLoss.lostReason(in: reply, sessionId: "s1"),
            "the daemon released session s1 (Session not found: s1)"
        )
    }

    func testSuccessAndUnreachableDaemonAreNotLoss() {
        XCTAssertNil(HeldSessionLoss.lostReason(in: ["success": true], sessionId: "s1"))
        XCTAssertNil(HeldSessionLoss.lostReason(in: nil, sessionId: "s1"), "a transient miss is not a release")
        XCTAssertNil(HeldSessionLoss.lostReason(in: ["success": false, "error": "busy"], sessionId: "s1"))
    }

    func testDefaultCadenceKeepsTheWorstHeartbeatGapWellUnderTheDaemonLease() {
        // A beat that runs to its request timeout, then the sleep, must still land with half the
        // lease to spare; 2 s + 2 s used the whole 4 s lease (#11195).
        XCTAssertLessThanOrEqual(
            DaemonSocketHeldSessionController.worstCaseHeartbeatGapSeconds,
            DaemonSocketHeldSessionController.daemonOwnerLeaseSeconds / 2
        )
    }

    func testLoopRecordsLossAndStopsHeartbeating() async throws {
        let calls = Counter()
        let controller = DaemonSocketHeldSessionController(
            socketPath: "unused",
            heartbeatIntervalSeconds: 0.001,
            sendHeartbeat: { _ in
                let n = calls.increment()
                if n < 3 { return ["success": true] }
                return ["success": false, "code": "daemon_session_not_found", "releaseReason": "daemon-shutdown"]
            }
        )
        let handle = controller.startHeartbeating(sessionId: "s1")
        for _ in 0 ..< 500 where handle.lostReason == nil {
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTAssertEqual(handle.lostReason, "the daemon released session s1 (daemon-shutdown)")
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(calls.value, 3, "the loop ends at the first not-found reply")
        handle.stop()
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}
