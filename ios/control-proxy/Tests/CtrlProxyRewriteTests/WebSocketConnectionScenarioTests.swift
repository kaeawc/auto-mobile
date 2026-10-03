@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// Missing connection-level cases; basic text, ping, close, and HTTP routing already have tests.
final class WebSocketConnectionScenarioTests: XCTestCase {
    func testMaskedBinaryPreservesNonUTF8Bytes() throws {
        let payload = Data([0x00, 0xFF, 0x80, 0x01, 0xFE])
        let recorder = try run(LoopbackClient.encode(payload, opcode: 2))

        XCTAssertEqual(recorder.messages, [payload])
        XCTAssertEqual(recorder.upgrades, 1)
        XCTAssertEqual(recorder.sends.count, 2)
    }

    func testMaskedTextWith16BitLengthThenShortFrame() throws {
        try assertExtendedFrame(length: 126, opcode: 1)
    }

    func testMaskedBinaryWith64BitLengthThenShortFrame() throws {
        try assertExtendedFrame(length: 65536, opcode: 2)
    }

    func testPingBetweenFragmentsDoesNotDeliverOrResetPartialMessage() throws {
        let ping = Data("probe".utf8)
        let recorder = try run(
            LoopbackClient.encode(Data("hel".utf8), final: false)
                + LoopbackClient.encode(ping, opcode: 9)
                + LoopbackClient.encode(Data("l".utf8), opcode: 0, final: false)
                + LoopbackClient.encode(Data("o".utf8), opcode: 0)
                + LoopbackClient.encode(Data("next".utf8))
        )

        XCTAssertEqual(recorder.messages, [Data("hello".utf8), Data("next".utf8)])
        XCTAssertEqual(recorder.upgrades, 1)
        XCTAssertEqual(recorder.sends.count, 3)
        XCTAssertEqual(recorder.sends.last, RewriteFraming.createFrame(data: ping, opcode: 10))
    }

    func testCloseReplyPreservesStatusAndReason() throws {
        let payload = Data([0x03, 0xE8]) + Data("done".utf8)
        let recorder = try run(LoopbackClient.encode(payload, opcode: 8))

        XCTAssertTrue(recorder.messages.isEmpty)
        XCTAssertEqual(recorder.sends.count, 3)
        // Bug: parseWebSocketFrame replies before reading the close payload, discarding
        // its status and reason. RFC 6455 §5.5.1 recommends echoing the received status.
        XCTExpectFailure("Close reply discards the client's status and reason") {
            XCTAssertEqual(recorder.sends.last, RewriteFraming.createFrame(data: payload, opcode: 8))
        }
    }

    private func assertExtendedFrame(length: Int, opcode: UInt8) throws {
        let payload = opcode == 1
            ? Data(repeating: 0x61, count: length)
            : Data((0 ..< length).map { UInt8(truncatingIfNeeded: $0) })
        let next = Data("after-extended".utf8)
        let recorder = try run(LoopbackClient.encode(payload, opcode: opcode) + LoopbackClient.encode(next))

        // A following frame checks that extended length and mask bytes were consumed exactly.
        XCTAssertEqual(recorder.messages, [payload, next])
        XCTAssertEqual(recorder.upgrades, 1)
        XCTAssertEqual(recorder.sends.count, 2)
    }

    private func run(_ frames: Data) throws -> ConnectionRecorder {
        let handshake = Data(
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                .utf8
        )
        let queue = DispatchQueue(label: "ctrlproxy.scripted.scenario")
        let recorder = ConnectionRecorder()
        let channel = UpgradeBoundaryChannel(handshake: handshake, frames: frames, recorder: recorder)
        let connection = WebSocketConnection(
            id: 1, channel: channel, queue: queue, boundPort: 0,
            onUpgrade: { recorder.upgrades += 1 },
            onMessage: { recorder.messages.append($0) },
            onClose: { recorder.closes += 1 }
        )
        let settled = XCTestExpectation(description: "scripted scenario and cancellation settled")
        connection.start()
        defer { connection.close() }
        // All receives after the separate handshake are exact-length synchronous callbacks.
        // The nested barrier also drains the fake's queued cancellation notification.
        queue.async {
            connection.close()
            queue.async { settled.fulfill() }
        }
        guard XCTWaiter.wait(for: [settled], timeout: 0.1) == .completed else {
            throw ScenarioError.deadline
        }
        return recorder
    }
}

/// Adapts the existing scripted fake to a client that sends frames after the upgrade.
/// Mutable state is confined to the connection queue, just like the underlying fake.
private final class UpgradeBoundaryChannel: ByteChannel, @unchecked Sendable {
    private var handshake: Data?
    private let frames: RewriteScriptedByteChannel

    init(handshake: Data, frames: Data, recorder: ConnectionRecorder) {
        self.handshake = handshake
        self.frames = RewriteScriptedByteChannel(inbound: frames, recorder: recorder)
    }

    var onState: (@Sendable (ByteChannelState) -> Void)? {
        get { frames.onState }
        set { frames.onState = newValue }
    }

    func start(queue: DispatchQueue) { frames.start(queue: queue) }
    func cancel() { frames.cancel() }
    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void) {
        frames.send(data, completion: completion)
    }

    func receive(
        minimumIncompleteLength: Int, maximumLength: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    ) {
        if let handshake {
            precondition(handshake.count <= maximumLength)
            self.handshake = nil
            completion(handshake, false, nil)
        } else {
            frames.receive(
                minimumIncompleteLength: minimumIncompleteLength, maximumLength: maximumLength,
                completion: completion
            )
        }
    }
}

private enum ScenarioError: Error { case deadline }
