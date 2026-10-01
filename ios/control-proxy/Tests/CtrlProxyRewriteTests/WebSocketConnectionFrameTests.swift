@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// Drives the real connection state machine over a deterministic in-memory byte channel.
/// The first receive stops at the HTTP upgrade boundary; subsequent receives carry WebSocket
/// frames, as a socket would after the upgrade response is sent.
final class WebSocketConnectionFrameTests: XCTestCase {
    func testPingConsumesPayloadAndRepliesWithPongBeforeDeliveringNextTextFrame() {
        let messageReceived = expectation(description: "text message delivered")
        let harness = makeHarness(
            frames: clientFrame(opcode: 0x09, payload: Data("probe".utf8))
                + clientFrame(opcode: 0x01, payload: Data("hello".utf8)),
            onMessage: { _ in messageReceived.fulfill() }
        )

        harness.start()
        wait(for: [messageReceived], timeout: 1)

        XCTAssertEqual(harness.recorder.upgrades, 1)
        XCTAssertEqual(harness.recorder.messages, [Data("hello".utf8)])
        XCTAssertEqual(harness.recorder.sends.count, 3, "upgrade response, connected event, then pong")
        XCTAssertEqual(harness.recorder.sends[2], serverFrame(opcode: 0x0A, payload: Data("probe".utf8)))
    }

    func testCloseFrameIsEchoedAndClosesOnce() {
        let closed = expectation(description: "connection closed")
        let harness = makeHarness(
            frames: clientFrame(opcode: 0x08, payload: Data()),
            onClose: { closed.fulfill() }
        )

        harness.start()
        wait(for: [closed], timeout: 1)

        XCTAssertEqual(harness.recorder.sends.count, 3, "upgrade response, connected event, then close echo")
        XCTAssertEqual(harness.recorder.sends[2], serverFrame(opcode: 0x08, payload: Data()))
        XCTAssertEqual(harness.recorder.closes, 1)
    }

    func testFragmentedTextMessageIsDeliveredOnlyAfterFinalContinuation() {
        let messageReceived = expectation(description: "assembled message delivered")
        let harness = makeHarness(
            frames: clientFrame(opcode: 0x01, payload: Data("hel".utf8), isFinal: false)
                + clientFrame(opcode: 0x00, payload: Data("lo".utf8), isFinal: true),
            onMessage: { _ in messageReceived.fulfill() }
        )

        harness.start()
        wait(for: [messageReceived], timeout: 1)

        XCTAssertEqual(harness.recorder.messages, [Data("hello".utf8)])
        XCTAssertEqual(harness.recorder.upgrades, 1)
        XCTAssertEqual(harness.recorder.sends.count, 2, "upgrade response followed by connected event")
    }

    private func makeHarness(
        frames: Data,
        onMessage: @escaping @Sendable (Data) -> Void = { _ in },
        onClose: @escaping @Sendable () -> Void = {}
    )
        -> Harness
    {
        let queue = DispatchQueue(label: "websocket.connection.frame.test")
        let recorder = ConnectionRecorder()
        let handshake = Data(
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                .utf8
        )
        let channel = InMemoryByteChannel(
            inbound: handshake + frames,
            firstReceiveLimit: handshake.count,
            recorder: recorder
        )
        let connection = WebSocketConnection(
            id: 1,
            channel: channel,
            queue: queue,
            boundPort: 8765,
            onUpgrade: { recorder.upgrades += 1 },
            onMessage: { data in
                recorder.messages.append(data)
                onMessage(data)
            },
            onClose: {
                recorder.closes += 1
                onClose()
            }
        )
        return Harness(queue: queue, connection: connection, channel: channel, recorder: recorder)
    }

    private func clientFrame(opcode: UInt8, payload: Data, isFinal: Bool = true) -> Data {
        let mask: [UInt8] = [0x11, 0x22, 0x33, 0x44]
        precondition(payload.count < 126)
        var frame = Data([(isFinal ? 0x80 : 0x00) | opcode, 0x80 | UInt8(payload.count)])
        frame.append(contentsOf: mask)
        frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % mask.count] })
        return frame
    }

    private func serverFrame(opcode: UInt8, payload: Data) -> Data {
        var frame = Data([0x80 | opcode, UInt8(payload.count)])
        frame.append(payload)
        return frame
    }
}

private struct Harness {
    let queue: DispatchQueue
    let connection: WebSocketConnection
    let channel: InMemoryByteChannel
    let recorder: ConnectionRecorder

    func start() {
        connection.start()
    }
}

/// Supplies the handshake in its own receive, then serves the remaining frame stream in exact
/// requested lengths. All channel callbacks run on the connection queue for deterministic tests.
private final class InMemoryByteChannel: ByteChannel, @unchecked Sendable {
    var onState: (@Sendable (ByteChannelState) -> Void)?
    private var inbound: Data
    private let firstReceiveLimit: Int
    private let recorder: ConnectionRecorder
    private var isFirstReceive = true
    private var queue: DispatchQueue?

    init(inbound: Data, firstReceiveLimit: Int, recorder: ConnectionRecorder) {
        self.inbound = inbound
        self.firstReceiveLimit = firstReceiveLimit
        self.recorder = recorder
    }

    func start(queue: DispatchQueue) {
        self.queue = queue
        queue.async { [weak self] in self?.onState?(.ready) }
    }

    func receive(
        minimumIncompleteLength _: Int,
        maximumLength: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    ) {
        guard !inbound.isEmpty else { return }
        let limit = isFirstReceive ? firstReceiveLimit : maximumLength
        isFirstReceive = false
        let count = Swift.min(limit, Swift.min(maximumLength, inbound.count))
        let chunk = Data(inbound.prefix(count))
        inbound.removeFirst(count)
        completion(chunk, false, nil)
    }

    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void) {
        recorder.sends.append(data)
        completion(nil)
    }

    func cancel() {
        queue?.async { [weak self] in self?.onState?(.cancelled) }
    }
}
