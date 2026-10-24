@testable import AutoMobilePrototypeAgentCore
import Foundation

final class FakePinnedConnection: PrototypePinnedConnection, @unchecked Sendable {
    private let lock = NSLock()
    let remoteAddress: String?
    private var chunks: [Data]
    private var writes: [Data] = []
    private var reads = 0
    private var stopped = false
    var pause: FakePinnedSignal?
    var onCancel: (@Sendable () -> Void)?
    var onReceive: (@Sendable () -> Void)?

    init(_ response: String = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", address: String? = "8.8.8.8") {
        remoteAddress = address
        chunks = [Data(response.utf8)]
    }

    init(chunks: [String], address: String? = "8.8.8.8") {
        remoteAddress = address
        self.chunks = chunks.map { Data($0.utf8) }
    }

    var sent: String { lock.withLock { String(data: writes.reduce(Data(), +), encoding: .utf8) ?? "<invalid UTF-8>" } }
    var cancelled: Bool { lock.withLock { stopped } }
    var receiveCount: Int { lock.withLock { reads } }
    func send(_ data: Data) async throws { lock.withLock { writes.append(data) } }
    func receive(maximumLength: Int) async throws -> Data {
        onReceive?()
        if let pause { await pause.wait(); try Task.checkCancellation() }
        return lock.withLock {
            reads += 1
            guard !chunks.isEmpty else { return Data() }
            let bytes = chunks.removeFirst()
            if bytes.count > maximumLength { chunks.insert(Data(bytes.dropFirst(maximumLength)), at: 0) }
            return Data(bytes.prefix(maximumLength))
        }
    }

    func cancel() {
        lock.withLock { stopped = true }
        pause?.release()
        onCancel?()
    }
}

final class FakePinnedConnector: PrototypePinnedConnecting, @unchecked Sendable {
    struct Dial: Equatable { let address: String; let port: Int; let tlsServerName: String? }
    private let lock = NSLock()
    private var calls: [Dial] = []
    private var outcomes: [Result<any PrototypePinnedConnection, Error>]
    init(_ connections: [FakePinnedConnection]) { outcomes = connections.map { .success($0) } }
    init(outcomes: [Result<any PrototypePinnedConnection, Error>]) { self.outcomes = outcomes }
    var started: FakePinnedSignal?
    var pause: FakePinnedSignal?
    let finished = FakePinnedSignal()
    var dials: [Dial] { lock.withLock { calls } }
    func connect(address: String, port: Int, tlsServerName: String?) async throws -> any PrototypePinnedConnection {
        started?.release()
        if let pause { await pause.wait() }
        defer { finished.release() }
        return try lock.withLock {
            calls.append(Dial(address: address, port: port, tlsServerName: tlsServerName))
            guard !outcomes.isEmpty else { throw URLError(.cannotConnectToHost) }
            return try outcomes.removeFirst().get()
        }
    }
}

final class FakePinnedDeadline: PrototypeDNSDeadlineScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (@Sendable () -> Void)?
    var immediate = false
    private var calls = 0
    var scheduleCount: Int { lock.withLock { calls } }
    func schedule(afterMilliseconds: Int, _ fire: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        lock.withLock { callback = fire; calls += 1 }
        if immediate { fire() }
        return { [self] in lock.withLock { callback = nil } }
    }

    func fire() { lock.withLock { callback }?() }
}

func pinnedRequest(
    _ url: String = "https://public.example/", method: PrototypeRequestMethod = .get,
    headers: [String: String] = [:], body: JSONValue? = nil, maxBytes: Int = 1000
)
    -> PrototypeHttpRequest
{
    PrototypeHttpRequest(job: PrototypeRequestJob(
        requestId: "r", prototypeId: "p", via: .device, method: method, url: url,
        headers: headers, body: body, timeoutMs: 1000
    ), maxResponseBytes: maxBytes)
}

/// A deterministic rendezvous: no sleeps, polling, DNS or socket I/O.
final class FakePinnedSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var released = false
    private var releases = 0
    var releaseCount: Int { lock.withLock { releases } }
    private var continuations: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        await withCheckedContinuation { continuation in
            let done = lock.withLock {
                if released { return true }
                continuations.append(continuation)
                return false
            }
            if done { continuation.resume() }
        }
    }

    func release() {
        let pending = lock.withLock {
            releases += 1
            released = true
            defer { continuations = [] }
            return continuations
        }
        for continuation in pending {
            continuation.resume()
        }
    }
}
