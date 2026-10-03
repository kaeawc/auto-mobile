@testable import CtrlProxyRewrite
import Foundation
import Network
import XCTest

final class WebSocketDeadlineSmokeTests: XCTestCase {
    func testEphemeralLoopbackUpgradeTextEchoAndTeardownWithinOneSecond() throws {
        // One budget for the entire exchange, not a fresh timeout for every receive.
        let deadline = DispatchTime.now().uptimeNanoseconds + 900_000_000
        let queue = DispatchQueue(label: "ctrlproxy.deadline.loopback")
        let listener = try WebSocketServer.makeLoopbackListener(port: 0)
        let listening = XCTestExpectation(description: "listener ready or failed")
        let listenerCancelled = XCTestExpectation(description: "listener cancelled")
        let serverClosed = XCTestExpectation(description: "server connection closed")
        let serverState = LoopbackBox(SmokeServerState())
        let messages = ValueBox<Data>()
        let stopServer: @Sendable () -> Void = {
            let connections = serverState.update {
                $0.stopping = true
                return $0.connections
            }
            listener.cancel()
            connections.forEach { $0.close() }
        }
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: listening.fulfill()
            case .cancelled: listenerCancelled.fulfill()
            default: break
            }
        }
        listener.newConnectionHandler = { socket in
            let channel = NWByteChannel(socket)
            let connection = WebSocketConnection(
                id: 1,
                channel: channel,
                queue: queue,
                boundPort: 0,
                onMessage: { data in
                    messages.append(data)
                    channel.send(RewriteFraming.createFrame(data: data, opcode: 1)) { _ in }
                },
                onClose: { serverClosed.fulfill() }
            )
            let accepted = serverState.update {
                guard !$0.stopping else { return false }
                $0.connections.append(connection)
                return true
            }
            guard accepted else { socket.cancel(); return }
            connection.start()
        }
        listener.start(queue: queue)
        defer { stopServer() }
        try waitUntilDeadline([listening], deadline: deadline)
        let port = try XCTUnwrap(listener.port)
        XCTAssertNotEqual(port.rawValue, 0)

        let client = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        let connected = XCTestExpectation(description: "client ready or failed")
        let clientCancelled = XCTestExpectation(description: "client cancelled")
        client.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: connected.fulfill()
            case .cancelled: clientCancelled.fulfill()
            default: break
            }
        }
        client.start(queue: queue)
        defer { client.cancel() }
        try waitUntilDeadline([connected], deadline: deadline)
        try send(
            Data(
                "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                    .utf8
            ),
            to: client, deadline: deadline
        )

        var received = Data()
        let separator = Data("\r\n\r\n".utf8)
        while !received.contains(separator) {
            try received.append(receive(from: client, deadline: deadline))
        }
        let boundary = try XCTUnwrap(received.range(of: separator))
        let header = try XCTUnwrap(String(data: received.prefix(boundary.upperBound), encoding: .utf8))
        XCTAssertTrue(header.hasPrefix("HTTP/1.1 101 Switching Protocols\r\n"))
        XCTAssertTrue(header.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="))
        received.removeFirst(boundary.upperBound)

        let payload = Data("smoke".utf8)
        try send(LoopbackClient.encode(payload), to: client, deadline: deadline)
        // Independent wire expectation: FIN + text opcode, unmasked five-byte payload.
        let echo = Data([0x81, 0x05]) + payload
        while !received.suffix(echo.count).elementsEqual(echo) {
            try received.append(receive(from: client, deadline: deadline))
        }
        XCTAssertEqual(messages.values, [payload])
        client.cancel()
        stopServer()
        try waitUntilDeadline([clientCancelled, serverClosed, listenerCancelled], deadline: deadline)
    }

    private func send(_ data: Data, to client: NWConnection, deadline: UInt64) throws {
        let sent = XCTestExpectation(description: "client send")
        let result = LoopbackBox<NWError?>(nil)
        client.send(content: data, completion: .contentProcessed { error in
            result.update { $0 = error }
            sent.fulfill()
        })
        try waitUntilDeadline([sent], deadline: deadline)
        if let error = result.read() { throw error }
    }

    private func receive(from client: NWConnection, deadline: UInt64) throws -> Data {
        let received = XCTestExpectation(description: "client receive")
        let result = LoopbackBox<Result<Data, any Error>?>(nil)
        client.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
            result.update {
                if let error { $0 = .failure(error) }
                else if let data, !data.isEmpty { $0 = .success(data) }
                else { $0 = .failure(SmokeError.ended(complete)) }
            }
            received.fulfill()
        }
        try waitUntilDeadline([received], deadline: deadline)
        return try XCTUnwrap(result.read()).get()
    }

    private func waitUntilDeadline(_ expectations: [XCTestExpectation], deadline: UInt64) throws {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < deadline,
              XCTWaiter.wait(for: expectations, timeout: Double(deadline - now) / 1_000_000_000) == .completed
        else { throw SmokeError.deadline }
    }
}

private enum SmokeError: Error {
    case deadline
    case ended(Bool)
}

private struct SmokeServerState: Sendable {
    var connections: [WebSocketConnection] = []
    var stopping = false
}
