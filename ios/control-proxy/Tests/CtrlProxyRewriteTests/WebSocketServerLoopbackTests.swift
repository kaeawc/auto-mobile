// Self-contained loopback tests: droppable into SwiftPM or the Xcode UI-test bundle.
#if canImport(CtrlProxyRewrite)
    @testable import CtrlProxyRewrite
#endif
import Foundation
import XCTest

private final class LoopbackFixture {
    let server: WebSocketServer
    let port: UInt16
    let presence: LoopbackBox<[Bool]>
    let absent: [XCTestExpectation]
    private var clients: [LoopbackClient] = []

    init(handler: @escaping @Sendable (WebSocketRequest) -> any WebSocketResponsePayload = {
        WebSocketResponse.success(type: "hierarchy", requestId: $0.requestId, totalTimeMs: 0)
    }) throws {
        let listener = try LoopbackListener()
        let presence = LoopbackBox<[Bool]>([])
        let absent = (0 ..< 2).map { XCTestExpectation(description: "presence false \($0)") }
        self.presence = presence
        self.absent = absent
        server = WebSocketServer(
            port: 0,
            commandHandler: LoopbackCommandHandler(handler: handler),
            perf: LoopbackPerf(),
            frameContext: LoopbackFrameContext(),
            onClientPresenceChanged: { value in
                let index = presence.update {
                    $0.append(value)
                    return $0.filter { !$0 }.count - 1
                }
                if !value, absent.indices.contains(index) { absent[index].fulfill() }
            },
            listenerFactory: { requestedPort in
                XCTAssertEqual(requestedPort, 0)
                return listener
            }
        )
        do {
            try server.start()
            try loopbackWait(listener.ready)
            port = try XCTUnwrap(listener.listener.port).rawValue
            XCTAssertNotEqual(port, 0)
        } catch {
            server.stop()
            throw error
        }
    }

    func client() throws -> LoopbackClient {
        let client = try LoopbackClient(port: port)
        clients.append(client)
        return client
    }

    func stop() {
        clients.forEach { $0.cancel() }
        server.stop()
    }

    func close(_ client: LoopbackClient, absentIndex: Int? = nil) throws {
        // The close reply echoes the client's status 1000.
        try client.send(LoopbackClient.encode(Data([0x03, 0xE8]), opcode: 8))
        let close = try client.frame()
        XCTAssertEqual(close.opcode, 8)
        XCTAssertEqual(close.payload, Data([0x03, 0xE8]))
        try client.expectEnd(allowError: true)
        if let absentIndex { try loopbackWait(absent[absentIndex]) }
    }
}

final class WebSocketServerLoopbackTests: XCTestCase {
    func testRealHandshakeAndConnectedEvent() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        XCTAssertTrue(fixture.server.hasConnectedClients)
        XCTAssertEqual(fixture.presence.read(), [true])
    }

    func testCommandRoundTrip() throws {
        let observed = LoopbackBox<[String]>([])
        let fixture = try LoopbackFixture { request in
            observed.update { $0.append("\(request.typeString):\(request.requestId ?? "")") }
            return WebSocketResponse.success(type: "hierarchy", requestId: request.requestId, totalTimeMs: 0)
        }
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        try client.roundTrip("r1")
        XCTAssertEqual(observed.read(), ["request_hierarchy:r1"])
    }

    func testPingPongThenCommand() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        let payload = Data("keepalive".utf8)
        try client.send(LoopbackClient.encode(payload, opcode: 9))
        let pong = try client.frame()
        XCTAssertEqual(pong.opcode, 10)
        XCTAssertEqual(pong.payload, payload)
        try client.roundTrip("after-ping")
    }

    func testClientCloseThenFreshConnection() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        try fixture.close(client, absentIndex: 0)
        XCTAssertFalse(fixture.server.hasConnectedClients)
        XCTAssertEqual(fixture.presence.read(), [true, false])
        let fresh = try fixture.client()
        _ = try fresh.upgrade()
        try fresh.roundTrip("after-close")
        try fixture.close(fresh, absentIndex: 1)
        XCTAssertEqual(fixture.presence.read(), [true, false, true, false])
    }

    func testServerStopEndsTCPWithoutCloseFrame() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        fixture.server.stop()
        try client.expectEnd(allowError: true)
        try loopbackWait(fixture.absent[0])
        XCTAssertFalse(fixture.server.isRunning)
        XCTAssertFalse(fixture.server.hasConnectedClients)
        XCTAssertEqual(fixture.presence.read(), [true, false])
    }

    func testProtocolErrorEndsTCPWithoutCloseFrame() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        try client.send(LoopbackClient.encode(Data("orphan".utf8), opcode: 0))
        try client.expectEnd(allowError: true)
        try loopbackWait(fixture.absent[0])
        XCTAssertFalse(fixture.server.hasConnectedClients)
        XCTAssertTrue(fixture.server.isRunning)
        XCTAssertEqual(fixture.presence.read(), [true, false])
    }

    func testAbruptDisconnectMidCommandDoesNotWedgeChain() throws {
        let entered = XCTestExpectation(description: "handler entered")
        let completed = XCTestExpectation(description: "handler released")
        let release = DispatchSemaphore(value: 0)
        let releasedByTest = LoopbackBox(false)
        let observed = LoopbackBox<[String]>([])
        // Signal even if setup or an assertion fails, so a cooperative task cannot leak.
        defer { release.signal() }
        let fixture = try LoopbackFixture { request in
            observed.update { $0.append(request.requestId ?? "") }
            if request.requestId == "blocked" {
                entered.fulfill()
                let signaled = release.wait(timeout: .now() + 5) == .success
                releasedByTest.update { $0 = signaled }
                completed.fulfill()
            }
            return WebSocketResponse.success(type: "hierarchy", requestId: request.requestId, totalTimeMs: 0)
        }
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        try client.send(LoopbackClient.encode(loopbackRequest("blocked")))
        try loopbackWait(entered)
        client.cancel()
        try loopbackWait(fixture.absent[0])
        XCTAssertFalse(fixture.server.hasConnectedClients)
        release.signal()
        try loopbackWait(completed)
        XCTAssertTrue(releasedByTest.read(), "handler must be released by the test, not by its safety timeout")
        let fresh = try fixture.client()
        _ = try fresh.upgrade()
        try fresh.roundTrip("after-disconnect")
        XCTAssertEqual(observed.read(), ["blocked", "after-disconnect"])
        try fixture.close(fresh, absentIndex: 1)
        XCTAssertEqual(fixture.presence.read(), [true, false, true, false])
    }

    func testFragmentedRequestAndSplitFrameWrites() throws {
        let observed = LoopbackBox<[String]>([])
        let fixture = try LoopbackFixture { request in
            observed.update { $0.append(request.requestId ?? "") }
            return WebSocketResponse.success(type: "hierarchy", requestId: request.requestId, totalTimeMs: 0)
        }
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        let request = loopbackRequest("fragmented")
        try client.send(LoopbackClient.encode(Data(request.prefix(10)), final: false))
        let middle = LoopbackClient.encode(Data(request.dropFirst(10).prefix(10)), opcode: 0, final: false)
        try client.send(Data(middle.prefix(2)))
        try client.send(Data(middle.dropFirst(2)))
        try client.send(LoopbackClient.encode(Data(request.dropFirst(20)), opcode: 0))
        let response = try JSONDecoder().decode(WebSocketResponse.self, from: client.frame().payload)
        XCTAssertEqual(response.requestId, "fragmented")
        XCTAssertEqual(response.success, true)
        // A following command is a wire barrier: no extra fragmented dispatch can hide in the chain.
        try client.roundTrip("barrier")
        XCTAssertEqual(observed.read(), ["fragmented", "barrier"])
    }

    func testLargeRequestAndResponseAcrossTCPReads() throws {
        // Use a decoded text field so request logging stays small while the payload uses 64-bit lengths.
        let large = String(repeating: "L", count: 240_000)
        let observed = LoopbackBox<[String]>([])
        let fixture = try LoopbackFixture { request in
            guard case let .setText(payload) = request else {
                return WebSocketResponse.error(type: "error", requestId: request.requestId, error: "unexpected request")
            }
            observed.update { $0.append(payload.text) }
            return WebSocketResponse.success(
                type: "hierarchy",
                requestId: request.requestId,
                totalTimeMs: 0,
                text: payload.text
            )
        }
        defer { fixture.stop() }
        let client = try fixture.client()
        _ = try client.upgrade()
        let before = client.receiveCount
        let request = try JSONSerialization.data(withJSONObject: [
            "type": "request_set_text", "requestId": "large", "text": large,
        ])
        try client.send(LoopbackClient.encode(request))
        let frame = try client.frame()
        XCTAssertEqual(frame.opcode, 1)
        let response = try JSONDecoder().decode(WebSocketResponse.self, from: frame.payload)
        XCTAssertEqual(response.requestId, "large")
        XCTAssertEqual(response.text, large)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(observed.read(), [large])
        XCTAssertGreaterThan(client.receiveCount - before, 2)
    }

    func testTwoSequentialConnectionsHaveDifferentIds() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let first = try fixture.client()
        let firstId = try first.upgrade()
        try first.roundTrip("first")
        try fixture.close(first, absentIndex: 0)
        let second = try fixture.client()
        XCTAssertNotEqual(try second.upgrade(), firstId)
        try second.roundTrip("second")
        try fixture.close(second, absentIndex: 1)
        XCTAssertEqual(fixture.presence.read(), [true, false, true, false])
    }

    func testConcurrentConnectionsAndBroadcast() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let first = try fixture.client()
        let firstId = try first.upgrade()
        let second = try fixture.client()
        XCTAssertNotEqual(try second.upgrade(), firstId)
        try first.roundTrip("first")
        try second.roundTrip("second")
        XCTAssertEqual(fixture.presence.read(), [true])
        let broadcast = Data("{\"type\":\"loopback_broadcast\"}".utf8)
        fixture.server.broadcast(broadcast)
        let firstFrame = try first.frame()
        let secondFrame = try second.frame()
        XCTAssertEqual(firstFrame.opcode, 1)
        XCTAssertEqual(secondFrame.opcode, 1)
        XCTAssertEqual(firstFrame.payload, broadcast)
        XCTAssertEqual(secondFrame.payload, broadcast)
        try fixture.close(first)
        try second.roundTrip("last-client")
        XCTAssertTrue(fixture.server.hasConnectedClients)
        XCTAssertEqual(fixture.presence.read(), [true])
        try fixture.close(second, absentIndex: 0)
        XCTAssertFalse(fixture.server.hasConnectedClients)
        XCTAssertEqual(fixture.presence.read(), [true, false])
    }

    func testHTTPEndpointsDoNotCreateWebSocketPresence() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let health = try fixture.client().http("/health")
        XCTAssertTrue(health.header.hasPrefix("HTTP/1.1 200 OK"))
        let body = try JSONSerialization.jsonObject(with: health.body) as? [String: Any]
        XCTAssertEqual(body?["status"] as? String, "ok")
        // /health reports the constructor's port (0), not the ephemeral listener's port.
        let missing = try fixture.client().http("/missing")
        XCTAssertTrue(missing.header.hasPrefix("HTTP/1.1 404 Not Found"))
        XCTAssertTrue(missing.body.isEmpty)
        XCTAssertFalse(fixture.server.hasConnectedClients)
        XCTAssertEqual(fixture.presence.read(), [])
    }

    func testURLSessionWebSocketSmoke() throws {
        let fixture = try LoopbackFixture()
        defer { fixture.stop() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let url = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(fixture.port)/"))
        let client = session.webSocketTask(with: url)
        defer { client.cancel(with: .normalClosure, reason: nil) }
        client.resume()
        let connected = try loopbackAsync { try await client.receive() }
        guard case let .string(text) = connected else { return XCTFail("expected connected text") }
        let event = try JSONDecoder().decode(LoopbackConnected.self, from: Data(text.utf8))
        XCTAssertEqual(event.type, "connected")
        XCTAssertTrue(fixture.server.hasConnectedClients)
        let request = try XCTUnwrap(String(data: loopbackRequest("stock"), encoding: .utf8))
        try loopbackAsync { try await client.send(.string(request)) }
        let response = try loopbackAsync { try await client.receive() }
        guard case let .string(json) = response else { return XCTFail("expected response text") }
        XCTAssertEqual(try JSONDecoder().decode(WebSocketResponse.self, from: Data(json.utf8)).requestId, "stock")
        // Keep the stock stack's receive pump active while its ping callback awaits pong.
        let nextResponse = Task { try await client.receive() }
        defer { nextResponse.cancel() }
        let pong = XCTestExpectation(description: "stock client pong")
        let pingError = LoopbackBox<(any Error)?>(nil)
        client.sendPing { error in
            pingError.update { $0 = error }
            pong.fulfill()
        }
        let nextRequest = try XCTUnwrap(String(data: loopbackRequest("after-stock-ping"), encoding: .utf8))
        try loopbackAsync { try await client.send(.string(nextRequest)) }
        try loopbackWait(pong)
        if let error = pingError.read() { throw error }
        let afterPing = try loopbackAsync { try await nextResponse.value }
        guard case let .string(nextJSON) = afterPing else { return XCTFail("expected post-ping text") }
        XCTAssertEqual(
            try JSONDecoder().decode(WebSocketResponse.self, from: Data(nextJSON.utf8)).requestId,
            "after-stock-ping"
        )
        client.cancel(with: .normalClosure, reason: nil)
        try loopbackWait(fixture.absent[0])
        XCTAssertEqual(fixture.presence.read(), [true, false])
    }
}
