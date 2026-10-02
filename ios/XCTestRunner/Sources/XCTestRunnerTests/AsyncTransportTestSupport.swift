// swiftlint:disable force_unwrapping - fail-fast on bad fixtures is idiomatic in tests.
import Foundation
import os
import XCTest
@testable import XCTestRunner

/// Monotonic event counts replace scheduling guesses and wall-clock waits in async transport tests.
final class TransportEvents: Sendable {
    private struct State: Sendable {
        var count = 0
        var waiters: [(Int, SingleResumeCell<Void>)] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    var count: Int { state.withLock { $0.count } }

    func signal() {
        let ready = state.withLock { current in
            current.count += 1
            let ready = current.waiters.filter { $0.0 <= current.count }
            current.waiters.removeAll { $0.0 <= current.count }
            return ready
        }
        for (_, cell) in ready {
            cell.resume(returning: ())
        }
    }

    func wait(for count: Int) async throws {
        let cell = SingleResumeCell<Void>()
        let ready = state.withLock { current in
            if current.count >= count { return true }
            current.waiters.append((count, cell))
            return false
        }
        if ready { cell.resume(returning: ()) }
        try await cell.wait()
    }
}

/// Virtual time only. Cancellation removes the sleeper; an event signals after registration, allowing
/// advance to race the operation intentionally without any real timer or Task.sleep in tests.
final class VirtualDeadlineScheduler: DeadlineScheduler, Sendable {
    private struct Sleeper: Sendable {
        let due: TimeInterval
        let cell: SingleResumeCell<Void>
    }

    private struct State: Sendable {
        var now: TimeInterval = 0
        var sleepers: [Sleeper] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    let registered = TransportEvents()
    var pendingCount: Int { state.withLock { $0.sleepers.count } }

    func sleep(seconds: TimeInterval) async throws {
        try Task.checkCancellation()
        let cell = SingleResumeCell<Void>()
        try await withTaskCancellationHandler {
            let ready = state.withLock { current in
                // Cancellation removes under this lock, then resolves the cell after unlocking.
                // Reject registration even in the interval between those two steps.
                guard !Task.isCancelled, !cell.isResolved else { return false }
                if seconds <= 0 { return true }
                current.sleepers.append(Sleeper(due: current.now + seconds, cell: cell))
                return false
            }
            if ready { cell.resume(returning: ()) }
            registered.signal()
            try await cell.wait(cancellable: false)
        } onCancel: {
            self.state.withLock { current in
                current.sleepers.removeAll { $0.cell === cell }
            }
            cell.cancel()
        }
    }

    func advance(by seconds: TimeInterval) {
        let ready = state.withLock { current in
            current.now += seconds
            let ready = current.sleepers.filter { $0.due <= current.now }
            current.sleepers.removeAll { $0.due <= current.now }
            return ready
        }
        for sleeper in ready {
            sleeper.cell.resume(returning: ())
        }
    }
}

/// A fake socket retaining callback cells after cancellation, so tests can explicitly execute and
/// reject a late callback. Response fixtures below copy the existing daemon and HTTP test shapes.
final class AsyncFakeDaemonConnection: AsyncDaemonLineConnection, Sendable {
    private struct State: Sendable {
        var closed = false
        var sent: [Data] = []
        var pending: [SingleResumeCell<Data>] = []
        var history: [SingleResumeCell<Data>] = []
        var frames: [Data] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    let sends = TransportEvents()
    let receives = TransportEvents()
    let connects = TransportEvents()
    let cancellations = TransportEvents()
    let connectResult: SingleResumeCell<Void>?
    let sendError: (any Error)?
    let autoReply: Bool
    let interleave: Bool
    var sent: [Data] { state.withLock { $0.sent } }
    var isClosed: Bool { state.withLock { $0.closed } }

    init(autoReply: Bool = false, interleave: Bool = false, pauseConnect: Bool = false, sendError: (any Error)? = nil) {
        self.autoReply = autoReply
        self.interleave = interleave
        connectResult = pauseConnect ? SingleResumeCell<Void>() : nil
        self.sendError = sendError
    }

    func connect(timeout _: TimeInterval) async throws {
        try Task.checkCancellation()
        connects.signal()
        if isClosed { throw MCPClientError.requestFailed("Daemon connection closed") }
        if let connectResult { try await connectResult.wait() }
    }

    func sendLine(_ data: Data, timeout _: TimeInterval) async throws {
        try Task.checkCancellation()
        if let sendError { throw sendError }
        state.withLock { current in
            current.sent.append(data)
            if autoReply {
                let id = Self.requestId(data)
                if interleave { current.frames.append(TransportFixtures.daemonReply(id: "999")) }
                current.frames.append(TransportFixtures.daemonReply(id: id))
            }
        }
        sends.signal()
    }

    func receiveLine(timeout _: TimeInterval) async throws -> Data {
        let cell = SingleResumeCell<Data>()
        let result = state.withLock { current -> Result<Data, any Error>? in
            current.history.append(cell)
            if current.closed { return .failure(MCPClientError.requestFailed("Daemon connection closed")) }
            if !current.frames.isEmpty { return .success(current.frames.removeFirst()) }
            current.pending.append(cell)
            return nil
        }
        if let result {
            switch result {
            case let .success(data): cell.resume(returning: data)
            case let .failure(error): cell.resume(throwing: error)
            }
        }
        receives.signal()
        return try await cell.wait()
    }

    @discardableResult
    func deliver(_ data: Data) -> Bool {
        let (cell, buffered) = state.withLock { current -> (SingleResumeCell<Data>?, Bool) in
            if !current.pending.isEmpty { return (current.pending.removeFirst(), false) }
            guard !current.closed else { return (nil, false) }
            current.frames.append(data)
            return (nil, true)
        }
        if let cell { return cell.resume(returning: data) }
        return buffered
    }

    /// Invokes the retained callback even after the await completed; false proves it ran and lost.
    @discardableResult
    func deliverLate(_ data: Data, receive: Int = 0) -> Bool {
        let cell = state.withLock { $0.history[receive] }
        return cell.resume(returning: data)
    }

    func fail(_ error: any Error = MCPClientError.requestFailed("Daemon connection closed")) {
        let pending = state.withLock { current in
            current.closed = true
            let pending = current.pending
            current.pending.removeAll()
            return pending
        }
        for cell in pending {
            cell.resume(throwing: error)
        }
        connectResult?.resume(throwing: error)
    }

    func cancel() {
        fail()
        cancellations.signal()
    }

    static func requestId(_ data: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? String
        else {
            XCTFail("Expected a daemon request object with a string id")
            return ""
        }
        return id
    }
}

/// Factory access is lock-confined; each requested connection is supplied by the test in advance.
final class AsyncFakeDaemonFactory: AsyncDaemonLineConnectionFactory, Sendable {
    private let connections: OSAllocatedUnfairLock<[AsyncFakeDaemonConnection]>
    let creations = TransportEvents()

    init(_ connections: [AsyncFakeDaemonConnection]) {
        self.connections = OSAllocatedUnfairLock(initialState: connections)
    }

    func makeConnection(socketPath _: String) -> any AsyncDaemonLineConnection {
        let connection = connections.withLock { $0.removeFirst() }
        creations.signal()
        return connection
    }
}

/// Each exchange owns a cell; cancellation releases it, and callbacks remain accessible to prove
/// the late-response path was executed. Requests are captured as Sendable URLRequest/Data.
final class AsyncFakeHTTPPerformer: HTTPRequestPerforming, Sendable {
    struct Exchange: Sendable {
        let request: URLRequest
        let cell: SingleResumeCell<HTTPExchange>
    }

    private let exchanges = OSAllocatedUnfairLock<[Exchange]>(initialState: [])
    let requests = TransportEvents()
    let cancellations = TransportEvents()
    var captured: [Exchange] { exchanges.withLock { $0 } }

    func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try Task.checkCancellation()
        let cell = SingleResumeCell<HTTPExchange>()
        exchanges.withLock { $0.append(Exchange(request: request, cell: cell)) }
        requests.signal()
        return try await withTaskCancellationHandler {
            let response = try await cell.wait()
            return (response.data, response.response)
        } onCancel: {
            cell.cancel()
            self.cancellations.signal()
        }
    }

    @discardableResult
    func reply(_ index: Int, session: String = "s1", status: Int = 200, text: String = "ok") -> Bool {
        let exchange = captured[index]
        let id = Self.requestId(exchange.request)
        return exchange.cell.resume(returning: HTTPExchange(
            data: TransportFixtures.httpReply(id: id, text: text),
            response: HTTPURLResponse(
                url: exchange.request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json", "mcp-session-id": session]
            )!
        ))
    }

    @discardableResult
    func fail(_ index: Int, error: any Error) -> Bool { captured[index].cell.resume(throwing: error) }

    func failAll(_ error: any Error) {
        for exchange in captured {
            exchange.cell.resume(throwing: error)
        }
    }

    static func requestId(_ request: URLRequest) -> Int {
        guard let data = request.httpBody,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? Int
        else {
            XCTFail("Expected an HTTP request object with an integer id")
            return 0
        }
        return id
    }
}

/// Foundation response objects are Sendable, so no unchecked crossing is needed in the fake.
struct HTTPExchange: Sendable {
    let data: Data
    let response: URLResponse
}

/// These shapes are copied from AutoMobileDaemonClientTests.response and StreamableHTTPSSETests.okResult.
enum TransportFixtures {
    static func daemonReply(id: String, text: String = "ok") -> Data {
        Data(
            #"{"id":"\#(id)","type":"mcp_response","success":true,"result":{"content":[{"type":"text","text":"\#(text)"}]}}"#
                .utf8
        )
    }

    static func httpReply(id: Int, text: String = "ok") -> Data {
        Data(
            "{\"jsonrpc\":\"2.0\",\"id\":\(id),\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}}"
                .utf8
        )
    }
}

/// Exercises the temporary blocking wrappers on a GCD thread so the async test executor stays free.
func runSyncTransportTest<Value: Sendable>(
    _ operation: @escaping @Sendable () throws -> Value
)
    async throws -> Value
{
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(with: Result { try operation() })
        }
    }
}

func assertTransportCancellation<Value: Sendable>(
    _ task: Task<Value, any Error>,
    file: StaticString = #filePath,
    line: UInt = #line
)
    async
{
    switch await task.result {
    case .success: XCTFail("Expected cancellation", file: file, line: line)
    case let .failure(error): XCTAssertTrue(error is CancellationError, "\(error)", file: file, line: line)
    }
}

func assertTransportFailure<Value: Sendable>(
    _ task: Task<Value, any Error>, _ expected: MCPClientError,
    file: StaticString = #filePath, line: UInt = #line
)
    async
{
    switch await task.result {
    case .success: XCTFail("Expected \(expected)", file: file, line: line)
    case let .failure(error): XCTAssertEqual(error as? MCPClientError, expected, file: file, line: line)
    }
}

// swiftlint:enable force_unwrapping
