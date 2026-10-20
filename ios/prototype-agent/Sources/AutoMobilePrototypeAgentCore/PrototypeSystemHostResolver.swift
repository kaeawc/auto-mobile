import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

protocol HostResolving: Sendable {
    func addresses(for host: String) async throws -> [String]
}

/// Admission stays occupied until the blocking lookup actually returns, even after timeout.
/// A shared serial worker bounds both running getaddrinfo calls and queued work across clients.
protocol PrototypeDNSWorking: Sendable {
    func submit(_ work: @escaping @Sendable () -> Void) -> Bool
}

final class PrototypeDNSWorker: PrototypeDNSWorking, @unchecked Sendable {
    static let shared = PrototypeDNSWorker()
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.prototype-agent.dns")
    private var busy = false

    func submit(_ work: @escaping @Sendable () -> Void) -> Bool {
        let admitted = lock.withLock {
            guard !busy else { return false }
            busy = true
            return true
        }
        guard admitted else { return false }
        queue.async { [self] in
            defer { lock.withLock { busy = false } }
            work()
        }
        return true
    }
}

/// The UI PrototypeClock is main-queue-only and has non-Sendable callbacks. DNS needs a
/// cancellable background deadline; tests replace this narrow scheduling seam with a fake timer.
protocol PrototypeDNSDeadlineScheduling: Sendable {
    func schedule(afterMilliseconds: Int, _ fire: @escaping @Sendable () -> Void) -> @Sendable () -> Void
}

struct PrototypeDNSDeadline: PrototypeDNSDeadlineScheduling {
    func schedule(afterMilliseconds: Int, _ fire: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let deadline = Task {
            do { try await Task.sleep(for: .milliseconds(afterMilliseconds)) }
            catch { return }
            fire()
        }
        return { deadline.cancel() }
    }
}

private final class PrototypeDNSResolution: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<[String], Error>?
    private var cancelDeadline: (@Sendable () -> Void)?

    init(_ continuation: CheckedContinuation<[String], Error>) { self.continuation = continuation }

    var pending: Bool { lock.withLock { continuation != nil } }

    func installDeadline(_ cancel: @escaping @Sendable () -> Void) {
        let finished = lock.withLock {
            guard continuation != nil else { return true }
            cancelDeadline = cancel
            return false
        }
        if finished { cancel() }
    }

    func finish(_ result: Result<[String], Error>) {
        let (continuation, cancel) = lock.withLock {
            let saved = (self.continuation, cancelDeadline)
            self.continuation = nil
            cancelDeadline = nil
            return saved
        }
        cancel?()
        continuation?.resume(with: result)
    }
}

struct PrototypeSystemHostResolver: HostResolving {
    let timeoutMs: Int
    private let worker: any PrototypeDNSWorking
    private let deadlines: any PrototypeDNSDeadlineScheduling
    private let lookup: @Sendable (String) throws -> [String]

    init(
        timeoutMs: Int = 1000,
        worker: any PrototypeDNSWorking = PrototypeDNSWorker.shared,
        deadlines: any PrototypeDNSDeadlineScheduling = PrototypeDNSDeadline(),
        lookup: @escaping @Sendable (String) throws -> [String] = Self.lookup
    ) {
        self.timeoutMs = max(0, timeoutMs)
        self.worker = worker
        self.deadlines = deadlines
        self.lookup = lookup
    }

    func addresses(for host: String) async throws -> [String] {
        try await withCheckedThrowingContinuation { continuation in
            let resolution = PrototypeDNSResolution(continuation)
            resolution.installDeadline(deadlines.schedule(afterMilliseconds: timeoutMs) {
                resolution.finish(.failure(URLError(.timedOut)))
            })
            let admitted = worker.submit { [lookup] in
                guard resolution.pending else { return }
                resolution.finish(Result { try lookup(host) })
            }
            if !admitted { resolution.finish(.failure(URLError(.cannotFindHost))) }
        }
    }

    /// Returns every getaddrinfo result, without address-family filtering or a first-answer shortcut.
    private static func lookup(_ host: String) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else {
            throw URLError(.cannotFindHost)
        }
        defer { freeaddrinfo(first) }
        var addresses = Set<String>()
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let current = cursor {
            let info = current.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                info.ai_addr, info.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST
            ) == 0 else { throw URLError(.cannotFindHost) }
            let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
            guard let address = String(bytes: bytes, encoding: .utf8) else { throw URLError(.cannotFindHost) }
            addresses.insert(address)
            cursor = info.ai_next
        }
        return addresses.sorted()
    }
}
