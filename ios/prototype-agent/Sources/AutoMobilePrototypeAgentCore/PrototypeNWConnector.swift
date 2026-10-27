#if canImport(Network)
    import Darwin
    import Foundation
    import Network
    import Security

    /// No hostname lookup or proxy discovery occurs in this adapter: NWConnection receives an IP.
    struct PrototypeNWConnector: PrototypePinnedConnecting {
        private let onLocalNetworkDenied: @Sendable () -> Void

        init(onLocalNetworkDenied: @escaping @Sendable () -> Void = {}) {
            self.onLocalNetworkDenied = onLocalNetworkDenied
        }

        func connect(address: String, port: Int, tlsServerName: String?) async throws -> any PrototypePinnedConnection {
            guard let port = NWEndpoint.Port(rawValue: UInt16(exactly: port) ?? 0),
                  IPv4Address(address) != nil || IPv6Address(address) != nil
            else {
                throw URLError(.badURL)
            }
            let parameters = Self.parameters(tlsServerName: tlsServerName)
            let raw = NWConnection(host: NWEndpoint.Host(address), port: port, using: parameters)
            let connection = PrototypeNWConnection(raw, onLocalNetworkDenied: onLocalNetworkDenied)
            return try await withTaskCancellationHandler {
                try Task.checkCancellation()
                try await connection.start()
                try Task.checkCancellation()
                return connection
            } onCancel: {
                connection.cancel()
            }
        }

        private static func parameters(tlsServerName: String?) -> NWParameters {
            let tls = tlsServerName.map { name in
                let options = NWProtocolTLS.Options()
                sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, name)
                sec_protocol_options_add_tls_application_protocol(options.securityProtocolOptions, "http/1.1")
                sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, peer, complete in
                    let peerTrust = sec_trust_copy_ref(peer).takeRetainedValue()
                    guard let chain = SecTrustCopyCertificateChain(peerTrust) else { complete(false); return }
                    var trust: SecTrust?
                    let policy = SecPolicyCreateSSL(true, name as CFString)
                    guard SecTrustCreateWithCertificates(chain, policy, &trust) == errSecSuccess, let trust else {
                        complete(false)
                        return
                    }
                    complete(SecTrustEvaluateWithError(trust, nil))
                }, DispatchQueue.global())
                return options
            }
            let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
            parameters.preferNoProxies = true
            return parameters
        }
    }

    /// PolicyDenied also covers an unanswered permission prompt; only teardown concludes the wait.
    struct PrototypeNWWaitPolicy {
        enum Action {
            case ready
            case reject(Error)
            case keepWaiting
            case none
        }

        private(set) var awaitingPermission = false
        private(set) var stopped = false

        mutating func observe(_ state: NWConnection.State) -> Action {
            guard !stopped else { return .none }
            switch state {
            case .waiting(.dns(-65570)):
                awaitingPermission = true
                return .keepWaiting
            case .ready:
                awaitingPermission = false
                return .ready
            case let .failed(error), let .waiting(error):
                let mapped: Error = if case let .posix(code) = error { POSIXError(code) }
                else { error }
                return .reject(mapped)
            case .cancelled:
                return .reject(CancellationError())
            default:
                return .none
            }
        }

        /// Consumes the pending permission report once, including repeated cancellation callbacks.
        mutating func teardown() -> Bool {
            guard !stopped else { return false }
            stopped = true
            return awaitingPermission
        }
    }

    /// Network.framework owns its I/O queue; the lock protects readiness and the peer snapshot.
    private final class PrototypeNWConnection: PrototypePinnedConnection, @unchecked Sendable {
        private let connection: NWConnection
        private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.prototype-agent.pinned")
        private let lock = NSLock()
        private var ready: CheckedContinuation<Void, Error>?
        private var waitPolicy = PrototypeNWWaitPolicy()
        private let onLocalNetworkDenied: @Sendable () -> Void
        private var peer: String?
        var remoteAddress: String? { lock.withLock { peer } }

        init(_ connection: NWConnection, onLocalNetworkDenied: @escaping @Sendable () -> Void) {
            self.connection = connection
            self.onLocalNetworkDenied = onLocalNetworkDenied
        }

        func start() async throws {
            try await withCheckedThrowingContinuation { continuation in
                let cancelled = lock.withLock {
                    guard !waitPolicy.stopped else { return true }
                    ready = continuation
                    return false
                }
                guard !cancelled else { continuation.resume(throwing: CancellationError()); return }
                connection.stateUpdateHandler = { [weak self] state in self?.changed(state) }
                connection.start(queue: queue)
            }
        }

        private func changed(_ state: NWConnection.State) {
            let address = Self.address(connection.currentPath?.remoteEndpoint)
            let (action, continuation) = lock.withLock {
                let action = waitPolicy.observe(state)
                guard case .ready = action else { return (action, nil as CheckedContinuation<Void, Error>?) }
                peer = address
                defer { ready = nil }
                return (action, ready)
            }
            switch action {
            case .ready: continuation?.resume()
            case let .reject(error): reject(error)
            case .keepWaiting, .none: break
            }
        }

        private func reject(_ error: Error) {
            let (continuation, reportDenied) = lock.withLock {
                let reportDenied = waitPolicy.teardown()
                defer { ready = nil }
                return (ready, reportDenied)
            }
            connection.cancel()
            if reportDenied { onLocalNetworkDenied() }
            continuation?.resume(throwing: error)
        }

        func send(_ data: Data) async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                connection.send(content: data, completion: .contentProcessed { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                })
            }
        }

        func receive(maximumLength: Int) async throws -> Data {
            try await withCheckedThrowingContinuation { continuation in
                connection
                    .receive(minimumIncompleteLength: 1, maximumLength: maximumLength) { data, _, complete, error in
                        if let error { continuation.resume(throwing: error) }
                        else if let data, !data.isEmpty { continuation.resume(returning: data) }
                        else if complete { continuation.resume(returning: Data()) }
                        else { continuation.resume(throwing: URLError(.networkConnectionLost)) }
                    }
            }
        }

        func cancel() { reject(CancellationError()) }

        private static func address(_ endpoint: NWEndpoint?) -> String? {
            guard case let .hostPort(host, _) = endpoint else { return nil }
            let bytes: Data
            let family: Int32
            switch host {
            case let .ipv4(value): bytes = value.rawValue; family = AF_INET
            case let .ipv6(value): bytes = value.rawValue; family = AF_INET6
            default: return nil
            }
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            let converted = bytes.withUnsafeBytes { raw in
                inet_ntop(family, raw.baseAddress, &buffer, socklen_t(buffer.count)) != nil
            }
            guard converted else { return nil }
            guard let text = String(bytes: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, encoding: .utf8)
            else { return nil }
            return String(text.split(separator: "%", maxSplits: 1)[0])
        }
    }
#endif
