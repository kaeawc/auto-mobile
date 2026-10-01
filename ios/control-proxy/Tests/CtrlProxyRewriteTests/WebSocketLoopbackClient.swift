// Self-contained loopback support: droppable into SwiftPM or the Xcode UI-test bundle.
#if canImport(CtrlProxyRewrite)
    @testable import CtrlProxyRewrite
#endif
import Foundation
import Network
import os
import XCTest

private enum LoopbackError: Error { case timeout(String), ended, malformed }

final class LoopbackBox<T: Sendable>: Sendable {
    private let storage: OSAllocatedUnfairLock<T>
    init(_ value: T) { storage = OSAllocatedUnfairLock(initialState: value) }
    func read() -> T { storage.withLock { $0 } }
    @discardableResult
    func update<R: Sendable>(_ body: @Sendable (inout T) -> R) -> R { storage.withLock(body) }
}

func loopbackWait(_ expectation: XCTestExpectation, timeout: TimeInterval = 5) throws {
    guard XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    else { throw LoopbackError.timeout(expectation.expectationDescription) }
}

func loopbackAsync<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
    let done = XCTestExpectation(description: "async socket operation")
    let result = LoopbackBox<Result<T, any Error>?>(nil)
    let actualTask = Task {
        let value: Result<T, any Error>
        do { value = try .success(await operation()) } catch { value = .failure(error) }
        result.update { $0 = value }
        done.fulfill()
    }
    defer { actualTask.cancel() }
    try loopbackWait(done)
    return try XCTUnwrap(result.read()).get()
}

// Handler properties are lock-protected; NWListener itself is Network.framework Sendable.
final class LoopbackListener: ServerListening, Sendable {
    let listener: NWListener
    let ready = XCTestExpectation(description: "listener ready")
    private let state = LoopbackBox<(@Sendable (NWListener.State) -> Void)?>(nil)
    private let accepted = LoopbackBox<(@Sendable (NWConnection) -> Void)?>(nil)
    init() throws { listener = try WebSocketServer.makeLoopbackListener(port: 0) }
    var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)? {
        get { state.read() }
        set { state.update { $0 = newValue } }
    }

    var newConnectionHandler: (@Sendable (NWConnection) -> Void)? {
        get { accepted.read() }
        set { accepted.update { $0 = newValue } }
    }

    func start(queue: DispatchQueue) {
        listener.stateUpdateHandler = { [weak self] value in
            guard let self else { return }
            state.read()?(value)
            if case .ready = value { ready.fulfill() }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accepted.read()?(connection) }
        listener.start(queue: queue)
    }

    func cancel() { listener.cancel() }
}

struct LoopbackCommandHandler: CommandHandling {
    let handler: @Sendable (WebSocketRequest) -> any WebSocketResponsePayload
    func handle(_ request: WebSocketRequest) async -> any WebSocketResponsePayload { handler(request) }
}

struct LoopbackPerf: PerfTracking {
    func serial(_: String) {}
    func end() {}
    func flush() -> [PerfTiming]? { nil }
    func snapshot(_: String) -> PerfTiming? { nil }
    func clear() {}
    func withScope<T>(_ body: nonisolated(nonsending)() async throws -> T) async rethrows -> T {
        try await body()
    }

    func withScope<T>(_ body: () throws -> T) rethrows -> T { try body() }
}

struct LoopbackFrameContext: FrameContextRecording {
    func recordTransition(to _: ViewHierarchy) -> String? { nil }
}

struct LoopbackFrame {
    let opcode: UInt8
    let payload: Data
}

// Synchronous methods and the receive buffer belong to the calling test thread.
// Callbacks only touch lock-protected result boxes, never the buffer.
final class LoopbackClient {
    let connection: NWConnection
    private var buffer = Data()
    private(set) var receiveCount = 0
    private var ended = false
    private var readDeadline: UInt64 = .max
    init(port: UInt16) throws {
        connection = try NWConnection(host: "127.0.0.1", port: XCTUnwrap(NWEndpoint.Port(rawValue: port)), using: .tcp)
        let ready = XCTestExpectation(description: "client ready")
        connection.stateUpdateHandler = { state in
            if case .ready = state { ready.fulfill() }
        }
        connection.start(queue: DispatchQueue(label: "loopback.client"))
        do { try loopbackWait(ready) } catch { connection.cancel(); throw error }
    }

    func cancel() { connection.cancel() }
    func send(_ data: Data) throws {
        let done = XCTestExpectation(description: "TCP send")
        let error = LoopbackBox<NWError?>(nil)
        connection.send(content: data, completion: .contentProcessed { value in
            error.update { $0 = value }; done.fulfill()
        })
        try loopbackWait(done)
        if let error = error.read() { throw error }
    }

    private func beginRead() { readDeadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000 }

    private func receive() throws {
        guard !ended else { throw LoopbackError.ended }
        let done = XCTestExpectation(description: "TCP receive")
        let result = LoopbackBox<(Data?, Bool, NWError?)>((nil, false, nil))
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { data, _, complete, error in
            result.update { $0 = (data, complete, error) }; done.fulfill()
        }
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < readDeadline else { throw LoopbackError.timeout("TCP read deadline") }
        try loopbackWait(done, timeout: min(3, Double(readDeadline - now) / 1_000_000_000))
        let (data, complete, error) = result.read()
        receiveCount += 1
        if let data { buffer.append(data) }
        ended = complete || error != nil
        // Network may deliver the final close bytes and ECONNRESET in the same callback.
        // Drain those bytes before treating the terminal condition as the end of the stream.
        if let error, data?.isEmpty != false { throw error }
    }

    func bytes(_ count: Int) throws -> Data {
        while buffer.count < count {
            try receive()
        }
        let data = Data(buffer.prefix(count)); buffer.removeFirst(count)
        return data
    }

    func http(_ path: String) throws -> (header: String, body: Data) {
        beginRead()
        try send(Data("GET \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".utf8))
        while !ended {
            guard buffer.count < 16384 else { throw LoopbackError.malformed }
            try receive()
        }
        let separator = try XCTUnwrap(buffer.range(of: Data("\r\n\r\n".utf8)))
        let header = try XCTUnwrap(String(data: buffer.prefix(separator.lowerBound), encoding: .utf8))
        return (header, Data(buffer.suffix(from: separator.upperBound)))
    }

    func upgrade() throws -> Int {
        beginRead()
        // RFC 6455's published sample key and independently known accept value.
        try send(
            Data(
                "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                    .utf8
            )
        )
        let separator = Data("\r\n\r\n".utf8)
        while !buffer.contains(separator) {
            guard buffer.count < 16384 else { throw LoopbackError.malformed }
            try receive()
        }
        let range = try XCTUnwrap(buffer.range(of: separator))
        let header = try XCTUnwrap(String(data: buffer.prefix(range.upperBound), encoding: .utf8))
        buffer.removeFirst(range.upperBound)
        XCTAssertTrue(header.hasPrefix("HTTP/1.1 101 "))
        XCTAssertTrue(header.lowercased().contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=".lowercased()))
        let connected = try frame()
        XCTAssertEqual(connected.opcode, 1)
        let event = try JSONDecoder().decode(LoopbackConnected.self, from: connected.payload)
        XCTAssertEqual(event.type, "connected")
        return event.id
    }

    static func encode(_ payload: Data, opcode: UInt8 = 1, final: Bool = true) -> Data {
        var bytes: [UInt8] = [(final ? 0x80 : 0) | opcode]
        if payload.count < 126 { bytes.append(0x80 | UInt8(payload.count)) }
        else {
            let width = payload.count <= 65535 ? 2 : 8
            bytes.append(width == 2 ? 0xFE : 0xFF)
            for shift in stride(from: (width - 1) * 8, through: 0, by: -8) {
                bytes.append(UInt8(truncatingIfNeeded: UInt64(payload.count) >> shift))
            }
        }
        let mask: [UInt8] = [0x12, 0x34, 0x56, 0x78]
        bytes.append(contentsOf: mask)
        bytes.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
        return Data(bytes)
    }

    func frame() throws -> LoopbackFrame {
        beginRead()
        let header = try [UInt8](bytes(2))
        XCTAssertEqual(header[1] & 0x80, 0, "server frames must be unmasked")
        XCTAssertEqual(header[0] & 0x80, 0x80)
        var length = UInt64(header[1] & 0x7F)
        if length == 126 || length == 127 {
            let extended = try bytes(length == 126 ? 2 : 8)
            length = extended.reduce(0) { ($0 << 8) | UInt64($1) }
        }
        guard length <= 1_000_000 else { throw LoopbackError.malformed }
        return try LoopbackFrame(opcode: header[0] & 0x0F, payload: bytes(Int(length)))
    }

    func expectEnd(allowError: Bool = false) throws {
        beginRead()
        // No intervening close/data frame is allowed on server stop/protocol failure.
        while !ended {
            do { try receive() } catch {
                if !allowError { throw error }
                guard ended else { throw error }
            }
        }
        XCTAssertTrue(buffer.isEmpty, "unexpected bytes before TCP teardown")
    }

    func roundTrip(_ id: String) throws {
        try send(Self.encode(loopbackRequest(id)))
        let response = try frame()
        XCTAssertEqual(response.opcode, 1)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: response.payload)
        XCTAssertEqual(decoded.requestId, id)
        XCTAssertEqual(decoded.success, true)
    }
}

struct LoopbackConnected: Decodable { let type: String; let id: Int }
func loopbackRequest(_ id: String) -> Data {
    Data("{\"type\":\"request_hierarchy\",\"requestId\":\"\(id)\"}".utf8)
}
