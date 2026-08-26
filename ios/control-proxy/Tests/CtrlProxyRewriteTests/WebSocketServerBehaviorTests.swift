@testable import CtrlProxyRewrite
import Foundation
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

        server.dispatchCommand(Data(#"{"type":"request_tap_coordinates","requestId":"r3","x":1,"y":2}"#.utf8), responder: responder)
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
