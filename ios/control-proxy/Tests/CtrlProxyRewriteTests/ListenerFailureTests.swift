@testable import CtrlProxyRewrite
import os
import XCTest

final class ListenerFailureTests: XCTestCase {
    func testListenerFailureNotifiesPresenceExactlyOnce() throws {
        let listener = FakeServerListener()
        let transitions = ValueBox<Bool>()
        let server = WebSocketServer(
            commandHandler: FakeCommandHandling { _ in WebSocketResponse(type: "noop") },
            perf: FakePerfTracking(flushResult: nil),
            frameContext: FakeFrameContextRecording(token: nil),
            onClientPresenceChanged: { transitions.append($0) },
            listenerFactory: { _ in listener }
        )
        try server.start()
        server.clientDidUpgrade(1)
        server.clientDidUpgrade(2)
        listener.fail()
        XCTAssertFalse(server.isRunning)
        XCTAssertFalse(server.hasConnectedClients)
        XCTAssertEqual(listener.cancellations, 1)
        XCTAssertEqual(transitions.values, [true, false])
        // Cancellation callbacks arrive later and must not repeat the transition.
        server.clientDidDisconnect(1)
        server.clientDidDisconnect(2)
        server.stop()
        XCTAssertEqual(transitions.values, [true, false])
    }

    func testLateFailureFromRetiredListenerDoesNotStopReplacement() throws {
        let oldListener = FakeServerListener()
        let newListener = FakeServerListener()
        let nextListener = OSAllocatedUnfairLock(initialState: oldListener)
        let server = WebSocketServer(
            commandHandler: FakeCommandHandling { _ in WebSocketResponse(type: "noop") },
            perf: FakePerfTracking(flushResult: nil),
            frameContext: FakeFrameContextRecording(token: nil),
            listenerFactory: { _ in nextListener.withLock { $0 } }
        )
        try server.start()
        server.stop()
        nextListener.withLock { $0 = newListener }
        try server.start()
        defer { server.stop() }
        server.clientDidUpgrade(1)
        oldListener.fail()
        XCTAssertTrue(server.isRunning)
        XCTAssertTrue(server.hasConnectedClients)
        XCTAssertEqual(newListener.cancellations, 0)
        newListener.fail()
        XCTAssertFalse(server.isRunning)
        XCTAssertFalse(server.hasConnectedClients)
    }
}
