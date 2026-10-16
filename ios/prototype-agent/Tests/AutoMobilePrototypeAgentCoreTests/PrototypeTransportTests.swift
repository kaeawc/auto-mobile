@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Deadlines advance only when the test releases them; no sockets or wall-clock waits.
private actor TransportDeadline {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var scheduled: [(Int, CheckedContinuation<Void, Never>)] = []

    func sleep() async {
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            let ready = scheduled.filter { $0.0 <= waiters.count }
            scheduled.removeAll { $0.0 <= waiters.count }
            ready.forEach { $0.1.resume() }
        }
    }

    func waitFor(_ count: Int) async {
        if waiters.count >= count { return }
        await withCheckedContinuation { scheduled.append((count, $0)) }
    }

    func release() {
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }
}

@MainActor
private final class TransportLog {
    var turns: [String] = []
    private var waiting: [(Int, CheckedContinuation<Void, Never>)] = []

    func append(_ turn: String) {
        turns.append(turn)
        let ready = waiting.filter { $0.0 <= turns.count }
        waiting.removeAll { $0.0 <= turns.count }
        ready.forEach { $0.1.resume() }
    }

    func waitFor(_ count: Int) async {
        if turns.count >= count { return }
        await withCheckedContinuation { waiting.append((count, $0)) }
    }
}

/// The writer's in-memory sink may run on any executor; the lock guards every byte access.
private final class TransportBytes: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private var cancellations = 0

    func append(_ bytes: Data) { lock.withLock { data.append(bytes) } }
    func cancel() { lock.withLock { cancellations += 1 } }
    var snapshot: Data { lock.withLock { data } }
    var cancelCount: Int { lock.withLock { cancellations } }
}

@MainActor
private final class TransportSocket {
    let input = AsyncThrowingStream<Data, Error>.makeStream()
    private let closed = AsyncStream<Void>.makeStream()
    private let storage = TransportBytes()
    var bytes: Data { storage.snapshot }
    var cancelCount: Int { storage.cancelCount }

    var connection: PrototypeTransportConnection {
        let input = input
        let closed = closed
        let storage = storage
        return PrototypeTransportConnection(chunks: input.stream, send: { data in
            storage.append(data)
        }, cancel: {
            storage.cancel()
            input.continuation.finish()
            closed.continuation.yield(())
        })
    }

    func waitClosed() async {
        var iterator = closed.stream.makeAsyncIterator()
        _ = await iterator.next()
    }

    func frames() throws -> [[String: Any]] {
        try bytes.split(separator: 0x0A).map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0)) as? [String: Any])
        }
    }
}

@MainActor
final class PrototypeTransportTests: XCTestCase {
    private let token = "0123456789abcdef"

    private func line(_ object: [String: Any]) throws -> Data {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        return data
    }

    private func hello() throws -> Data { try line(["type": "hello", "token": token]) }

    func testSingleHostRejectsBusyAndBadTokensWithoutAffectingFirstHost() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(
            token: token,
            maxAuthenticatedClients: 1,
            sleep: { _ in await clock.sleep() }
        )
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { _, _ in log.append("request") }
        delivery.onClientCountChanged = { log.append("count:\($0)") }
        let first = TransportSocket()
        let firstID = await transport.accept(first.connection)
        try await transport.receive(hello(), on: firstID)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1"])

        let busy = TransportSocket()
        let busyID = await transport.accept(busy.connection)
        // A pipelined request must not escape the failed gate after the valid second hello.
        try await transport.receive(hello() + line(["type": "get_prototype_status"]), on: busyID)
        await transport.waitForReader(busyID)
        await transport.flush()
        XCTAssertTrue(busy.bytes.isEmpty)
        XCTAssertGreaterThan(busy.cancelCount, 0)
        XCTAssertEqual(log.turns, ["count:1"])

        for message: [String: Any] in [["type": "hello", "token": "wrong"], ["type": "hello"]] {
            let rejected = TransportSocket()
            let rejectedID = await transport.accept(rejected.connection)
            try await transport.receive(line(message), on: rejectedID)
            await transport.waitForReader(rejectedID)
            await transport.flush()
            XCTAssertTrue(rejected.bytes.isEmpty)
            XCTAssertGreaterThan(rejected.cancelCount, 0)
            XCTAssertEqual(log.turns, ["count:1"])
        }

        delivery.broadcast(["type": "prototype_event", "sequence": 7])
        try await transport.receive(line(["type": "get_prototype_status"]), on: firstID)
        await transport.flush()
        XCTAssertEqual(first.cancelCount, 0)
        XCTAssertEqual(try first.frames().compactMap { $0["type"] as? String }, ["hello_result", "prototype_event"])
        XCTAssertEqual(try first.frames().last?["sequence"] as? Int, 7)
        XCTAssertTrue(busy.bytes.isEmpty)
        XCTAssertEqual(log.turns, ["count:1", "request"])
        await clock.waitFor(4)
        await transport.disconnected(firstID)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1", "request", "count:0"])
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testSingleHostReconnectReplaysOfflineEventsAfterHelloInOrder() async throws {
        let clock = TransportDeadline()
        let capabilities = PrototypeViewerHostCapabilities.advertised(
            PrototypeLifecycleMode.standalone.advertising(PrototypeAgentProtocol.capabilities)
        )
        let transport = PrototypeTransport(
            token: token, capabilities: capabilities, maxAuthenticatedClients: 1, sleep: { _ in await clock.sleep() }
        )
        var outbox = PrototypeEventOutbox<[String: Any]>(mode: .standalone)
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { _, _ in }
        delivery.onClientCountChanged = { [weak delivery] count in
            log.append("count:\(count)")
            for event in outbox.clientCountChanged(count) {
                delivery?.broadcast(event)
            }
        }
        for sequence in 1 ... 2 {
            XCTAssertTrue(outbox.publish(["type": "prototype_event", "sequence": sequence]).isEmpty)
        }
        let first = TransportSocket()
        let firstID = await transport.accept(first.connection)
        try await transport.receive(hello(), on: firstID)
        await transport.flush()
        let initial = try first.frames()
        XCTAssertEqual(
            initial.compactMap { $0["type"] as? String },
            ["hello_result", "prototype_event", "prototype_event"]
        )
        XCTAssertEqual(initial.compactMap { $0["sequence"] as? Int }, [1, 2])
        XCTAssertEqual(initial.first?["capabilities"] as? [String], capabilities)
        XCTAssertEqual(outbox.bufferedCount, 0)

        first.input.continuation.finish()
        await transport.waitForReader(firstID)
        await transport.flush()
        XCTAssertEqual(outbox.clients, 0)
        for sequence in 3 ... 5 {
            XCTAssertTrue(outbox.publish(["type": "prototype_event", "sequence": sequence]).isEmpty)
        }
        let replacement = TransportSocket()
        let replacementID = await transport.accept(replacement.connection)
        try await transport.receive(hello(), on: replacementID)
        await transport.flush()
        let replay = try replacement.frames()
        XCTAssertEqual(replay.first?["type"] as? String, "hello_result")
        XCTAssertEqual(replay.compactMap { $0["sequence"] as? Int }, [3, 4, 5])
        XCTAssertEqual(log.turns, ["count:1", "count:0", "count:1"])
        XCTAssertEqual(outbox.bufferedCount, 0)
        XCTAssertEqual(try first.frames().compactMap { $0["sequence"] as? Int }, [1, 2])
        for event in outbox.publish(["type": "prototype_event", "sequence": 6]) { delivery.broadcast(event) }
        await transport.flush()
        XCTAssertEqual(try replacement.frames().compactMap { $0["sequence"] as? Int }, [3, 4, 5, 6])
        await clock.waitFor(2)
        await transport.disconnected(replacementID)
        await transport.flush()
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testAHostRequestGoesToTheNewestAuthenticatedConnectionOnly() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let delivery = PrototypeTransportDelivery(transport: transport) { _, _ in }
        let first = TransportSocket()
        let second = TransportSocket()
        let firstID = await transport.accept(first.connection)
        let secondID = await transport.accept(second.connection)
        try await transport.receive(hello(), on: firstID)
        try await transport.receive(hello(), on: secondID)
        delivery.sendToHost(["type": "prototype_request", "requestId": "r1"])
        await transport.flush()
        XCTAssertEqual(try first.frames().compactMap { $0["type"] as? String }, ["hello_result"])
        XCTAssertEqual(
            try second.frames().compactMap { $0["type"] as? String },
            ["hello_result", "prototype_request"]
        )
        await transport.disconnected(secondID)
        delivery.sendToHost(["type": "prototype_request", "requestId": "r2"])
        await transport.flush()
        XCTAssertEqual(try first.frames().last?["requestId"] as? String, "r2")
        await transport.close()
        withExtendedLifetime(delivery) {}
    }

    func testDefaultLimitAllowsTwoAuthenticatedHostsAndBroadcastsToBoth() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { _, _ in }
        delivery.onClientCountChanged = { log.append("count:\($0)") }
        let first = TransportSocket()
        let second = TransportSocket()
        let firstID = await transport.accept(first.connection)
        let secondID = await transport.accept(second.connection)
        try await transport.receive(hello(), on: firstID)
        try await transport.receive(hello(), on: secondID)
        delivery.broadcast(["type": "prototype_event", "sequence": 1])
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1", "count:2"])
        for socket in [first, second] {
            XCTAssertEqual(socket.cancelCount, 0)
            XCTAssertEqual(
                try socket.frames().compactMap { $0["type"] as? String },
                ["hello_result", "prototype_event"]
            )
            XCTAssertEqual(try socket.frames().last?["sequence"] as? Int, 1)
        }
        await clock.waitFor(2)
        await transport.close()
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1", "count:2", "count:1", "count:0"])
        let afterClose = TransportSocket()
        let closedID = await transport.accept(afterClose.connection)
        try await transport.receive(hello(), on: closedID)
        await transport.flush()
        XCTAssertTrue(afterClose.bytes.isEmpty)
        XCTAssertEqual(afterClose.cancelCount, 1)
        XCTAssertEqual(log.turns, ["count:1", "count:2", "count:1", "count:0"])
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testFinishedInputDisconnectsAuthenticatedReader() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { _, _ in log.append("request") }
        delivery.onClientCountChanged = { log.append("count:\($0)") }
        let socket = TransportSocket()
        let id = await transport.accept(socket.connection)
        try socket.input.continuation.yield(hello())
        await log.waitFor(1)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1"])
        XCTAssertEqual(try socket.frames().first?["type"] as? String, "hello_result")
        await clock.waitFor(1)

        socket.input.continuation.finish()
        await transport.waitForReader(id)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1", "count:0"])
        XCTAssertEqual(socket.cancelCount, 1)
        let bytes = socket.bytes
        delivery.broadcast(["type": "prototype_event", "sequence": 1])
        await transport.flush()
        XCTAssertEqual(socket.bytes, bytes)
        XCTAssertEqual(log.turns, ["count:1", "count:0"])
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testThrowingInputDispatchesBufferedRequestBeforeDisconnect() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { message, _ in
            log.append("request:\(message["requestId"] as? String ?? "")")
        }
        delivery.onClientCountChanged = { log.append("count:\($0)") }
        let socket = TransportSocket()
        let id = await transport.accept(socket.connection)
        try socket.input.continuation.yield(hello())
        await log.waitFor(1)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1"])
        XCTAssertEqual(try socket.frames().first?["type"] as? String, "hello_result")
        await clock.waitFor(1)

        try socket.input.continuation.yield(line(["requestId": "last"]))
        socket.input.continuation.finish(throwing: CocoaError(.fileReadUnknown))
        await transport.waitForReader(id)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1", "request:last", "count:0"])
        XCTAssertEqual(socket.cancelCount, 1)
        let bytes = socket.bytes
        delivery.broadcast(["type": "prototype_event", "sequence": 1])
        await transport.flush()
        XCTAssertEqual(socket.bytes, bytes)
        XCTAssertEqual(log.turns, ["count:1", "request:last", "count:0"])
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testThousandFramesChunkedInRequestAndSequenceOrder() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        var sequence = 0
        var delivery: PrototypeTransportDelivery?
        delivery = PrototypeTransportDelivery(transport: transport) { message, reply in
            let request = message["requestId"] as? Int ?? -1
            log.append("request:\(request)")
            for _ in 0 ..< 2 {
                sequence += 1
                delivery?.broadcast(["type": "prototype_event", "sequence": sequence, "requestId": request])
            }
            reply(["type": "prototype_result", "requestId": request])
        }
        let socket = TransportSocket()
        let id = await transport.accept(socket.connection)
        var input = try hello()
        for request in 0 ..< 1000 {
            try input.append(line(["type": "request", "requestId": request]))
        }
        // Both split frames and multiple frames per chunk, through the actual per-client reader.
        var offset = 0
        let sizes = [1, 127, 4096, 3, 823]
        var chunk = 0
        while offset < input.count {
            let end = min(input.count, offset + sizes[chunk % sizes.count])
            socket.input.continuation.yield(input.subdata(in: offset ..< end))
            offset = end
            chunk += 1
        }
        await log.waitFor(1000)
        await transport.flush()
        let frames = try socket.frames()
        XCTAssertEqual(frames.first?["type"] as? String, "hello_result")
        XCTAssertEqual(frames.count, 3001)
        let results = frames.filter { $0["type"] as? String == "prototype_result" }
        let events = frames.filter { $0["type"] as? String == "prototype_event" }
        XCTAssertEqual(results.compactMap { $0["requestId"] as? Int }, Array(0 ..< 1000))
        XCTAssertEqual(events.compactMap { $0["sequence"] as? Int }, Array(1 ... 2000))
        for request in 0 ..< 1000 {
            let start = 1 + request * 3
            XCTAssertEqual(frames[start]["sequence"] as? Int, request * 2 + 1)
            XCTAssertEqual(frames[start + 1]["sequence"] as? Int, request * 2 + 2)
            XCTAssertEqual(frames[start + 2]["requestId"] as? Int, request)
            XCTAssertEqual(frames[start + 2]["type"] as? String, "prototype_result")
        }
        await clock.waitFor(1)
        await transport.disconnected(id)
        await clock.release()
        delivery = nil
    }

    func testDeferredReplyDoesNotBlockAndPreservesCallOrder() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        var held: PrototypeTransportDelivery.Reply?
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { message, reply in
            let request = message["requestId"] as? String ?? ""
            log.append(request)
            if request == "A" { held = reply } else { reply(["requestId": request]) }
        }
        let socket = TransportSocket()
        let id = await transport.accept(socket.connection)
        var input = try hello()
        try input.append(line(["requestId": "A"]))
        try input.append(line(["requestId": "B"]))
        await transport.receive(input, on: id)
        await transport.flush()
        XCTAssertEqual(log.turns, ["A", "B"])
        XCTAssertEqual(try socket.frames().dropFirst().compactMap { $0["requestId"] as? String }, ["B"])
        held?(["requestId": "A"])
        await transport.flush()
        XCTAssertEqual(try socket.frames().dropFirst().compactMap { $0["requestId"] as? String }, ["B", "A"])
        await clock.waitFor(1)
        await transport.disconnected(id)
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testCountAndDispatchShareOneTotalOrderWithIdempotentClose() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { message, reply in
            log.append("request:\(message["requestId"] as? String ?? "")")
            reply(["success": true])
        }
        delivery.onClientCountChanged = { log.append("count:\($0)") }
        let first = TransportSocket()
        let second = TransportSocket()
        let firstID = await transport.accept(first.connection)
        let secondID = await transport.accept(second.connection)
        try await transport.receive(hello() + line(["requestId": "A"]), on: firstID)
        try await transport.receive(hello() + line(["requestId": "B"]), on: secondID)
        await transport.disconnected(firstID)
        await transport.disconnected(firstID)
        try await transport.receive(line(["requestId": "C"]), on: secondID)
        await transport.disconnected(secondID)
        await transport.disconnected(secondID)
        await transport.flush()
        XCTAssertEqual(log.turns, ["count:1", "request:A", "count:2", "request:B", "count:1", "request:C", "count:0"])
        await clock.waitFor(2)
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testAuthenticationMalformedFramesAndFrameLimit() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { _, _ in log.append("request") }
        let pending = TransportSocket()
        let pendingID = await transport.accept(pending.connection)
        delivery.broadcast(["type": "prototype_event", "sequence": 1])
        await transport.flush()
        XCTAssertTrue(pending.bytes.isEmpty)
        XCTAssertTrue(log.turns.isEmpty)
        try await transport.receive(line(["type": "get_prototype_status"]), on: pendingID)
        await pending.waitClosed()
        await transport.flush()
        XCTAssertTrue(pending.bytes.isEmpty)
        XCTAssertTrue(log.turns.isEmpty)
        let oversized = TransportSocket()
        let largeID = await transport.accept(oversized.connection)
        await transport.receive(Data(repeating: 0x20, count: PrototypeAgentProtocol.maxHelloBytes + 1), on: largeID)
        await oversized.waitClosed()
        await transport.flush()
        XCTAssertTrue(oversized.bytes.isEmpty)
        let authenticated = TransportSocket()
        let authID = await transport.accept(authenticated.connection)
        try await transport.receive(hello(), on: authID)
        delivery.broadcast(["type": "prototype_event", "sequence": 2])
        await transport.receive(Data("[1]\n".utf8), on: authID)
        await transport.flush()
        let frames = try authenticated.frames()
        XCTAssertEqual(frames.count, 3)
        XCTAssertEqual(frames[0]["type"] as? String, "hello_result")
        XCTAssertEqual(frames[1]["type"] as? String, "prototype_event")
        XCTAssertEqual(frames[1]["sequence"] as? Int, 2)
        XCTAssertEqual(frames.last?["error"] as? String, "Request is not a JSON object")
        XCTAssertTrue(log.turns.isEmpty)
        await clock.waitFor(3)
        await transport.disconnected(authID)
        await clock.release()
        withExtendedLifetime(delivery) {}
    }

    func testInjectedHelloDeadlineClosesOnlyAwaitingHello() async throws {
        let clock = TransportDeadline()
        let transport = PrototypeTransport(token: token, sleep: { _ in await clock.sleep() })
        let log = TransportLog()
        let delivery = PrototypeTransportDelivery(transport: transport) { _, reply in
            log.append("request")
            reply(["success": true])
        }
        let pending = TransportSocket()
        let authenticated = TransportSocket()
        _ = await transport.accept(pending.connection)
        let authID = await transport.accept(authenticated.connection)
        try await transport.receive(hello(), on: authID)
        await clock.waitFor(2)
        await clock.release()
        await pending.waitClosed()
        // Pin the authenticated branch regardless of which released deadline runs first.
        await transport.helloDeadline(authID)
        try await transport.receive(line(["type": "get_prototype_status"]), on: authID)
        await transport.flush()
        XCTAssertTrue(pending.bytes.isEmpty)
        XCTAssertEqual(log.turns, ["request"])
        XCTAssertEqual(try authenticated.frames().count, 2)
        await transport.disconnected(authID)
        withExtendedLifetime(delivery) {}
    }
}
