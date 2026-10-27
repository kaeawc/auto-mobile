import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

protocol PrototypePinnedConnecting: Sendable {
    /// Dials exactly this literal; the original host is used only for TLS identity validation.
    func connect(address: String, port: Int, tlsServerName: String?) async throws -> any PrototypePinnedConnection
}

protocol PrototypePinnedConnection: AnyObject, Sendable {
    var remoteAddress: String? { get }
    func send(_ data: Data) async throws
    /// Empty data means EOF.
    func receive(maximumLength: Int) async throws -> Data
    func cancel()
}

struct PrototypePinnedHttpClient: PrototypeHttpClient {
    private let policy: PrototypeEgressPolicy
    private let resolver: any HostResolving
    private let connector: any PrototypePinnedConnecting
    private let deadlines: any PrototypeDNSDeadlineScheduling
    private let allowsCleartext: Bool
    private let onLocalNetworkDenied: @Sendable () -> Void
    private let nowMs: @Sendable () -> Double

    init(
        policy: PrototypeEgressPolicy = .init(),
        resolver: any HostResolving = PrototypeSystemHostResolver(),
        connector: any PrototypePinnedConnecting,
        deadlines: any PrototypeDNSDeadlineScheduling = PrototypeDNSDeadline(),
        allowsCleartext: Bool = false,
        nowMs: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 },
        onLocalNetworkDenied: @escaping @Sendable () -> Void = {}
    ) {
        self.policy = policy
        self.resolver = resolver
        self.connector = connector
        self.deadlines = deadlines
        self.allowsCleartext = allowsCleartext
        self.nowMs = nowMs
        self.onLocalNetworkDenied = onLocalNetworkDenied
    }

    #if canImport(Network)
        init(
            policy: PrototypeEgressPolicy = .init(),
            resolver: any HostResolving = PrototypeSystemHostResolver(),
            deadlines: any PrototypeDNSDeadlineScheduling = PrototypeDNSDeadline(),
            allowsCleartext: Bool = false,
            nowMs: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 },
            onLocalNetworkDenied: @escaping @Sendable () -> Void = {}
        ) {
            self.init(
                policy: policy,
                resolver: resolver,
                connector: PrototypeNWConnector(onLocalNetworkDenied: onLocalNetworkDenied),
                deadlines: deadlines,
                allowsCleartext: allowsCleartext,
                nowMs: nowMs,
                onLocalNetworkDenied: onLocalNetworkDenied
            )
        }
    #endif

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        let started = nowMs()
        let call = PrototypePinnedCall()
        let timeout = PrototypeRequestError(.timeout, "Request timed out after \(request.timeoutMs)ms.")
        let cancelled = PrototypeRequestError(.cancelled, "Request was cancelled.")
        do {
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    call.install(continuation)
                    if Task.isCancelled { call.finish(.failure(cancelled)); return }
                    call.install(deadline: deadlines.schedule(afterMilliseconds: request.timeoutMs) {
                        call.finish(.failure(timeout))
                    })
                    let task = Task {
                        guard call.active else { return }
                        do { try call.finish(.success(await execute(request, call: call, started: started))) }
                        catch { call.finish(.failure(error)) }
                    }
                    call.install(task: task)
                }
            } onCancel: {
                call.finish(.failure(cancelled))
            }
        } catch {
            let mapped = error as? PrototypeRequestError ?? Self.map(error, url: request.url)
            throw PrototypeHttpFailure(
                error: mapped, durationMs: elapsed(since: started),
                localNetworkDenied: error is PrototypeLocalNetworkDenied
            )
        }
    }

    private func execute(
        _ initial: PrototypeHttpRequest, call: PrototypePinnedCall, started: Double
    )
        async throws -> PrototypeHttpResponse
    {
        var request = initial
        for count in 0 ... 5 {
            try Task.checkCancellation()
            let url = try validatedURL(request)
            let addresses = try await checkedAddresses(url)
            try Task.checkCancellation()
            let connection = try await connect(addresses, url: url)
            try call.install(connection: connection)
            defer { connection.cancel() }
            try Task.checkCancellation()
            try await connection.send(PrototypeHTTP1Codec.serialize(request, url: url))
            let response = try await read(connection, request: request)
            if [301, 302, 303, 307, 308].contains(response.status), let location = response.headers["location"] {
                guard count < 5, let next = URL(string: location, relativeTo: url)?.absoluteURL,
                      !(url.scheme?.lowercased() == "https" && next.scheme?.lowercased() == "http")
                else { throw PrototypeRequestEgressCheck.blocked }
                request = Self.redirect(request, from: url, to: next, status: response.status)
                continue
            }
            return PrototypeHttpResponse(
                status: response.status,
                headers: response.headers,
                body: response.body,
                durationMs: elapsed(since: started)
            )
        }
        throw PrototypeRequestEgressCheck.blocked
    }

    private func validatedURL(_ request: PrototypeHttpRequest) throws -> URL {
        if let problem = PrototypeHttpHeaderCheck.problem(in: request.headers) { throw problem }
        guard let url = URL(string: request.url), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), let host = url.host, !host.isEmpty
        else {
            throw PrototypeRequestError(.invalidURL, "Not an absolute URL: \(request.url)")
        }
        if scheme == "http", !allowsCleartext {
            throw PrototypeRequestError(
                .blockedDestination,
                "Cleartext http is not permitted unless allowsCleartext is true."
            )
        }
        return url
    }

    private func checkedAddresses(_ url: URL) async throws -> [String] {
        let host = Self.host(url)
        let port = PrototypeRequestEgressCheck.port(url)
        guard policy.checkHost(host: host, port: port) == .allow else { throw PrototypeRequestEgressCheck.blocked }
        if let literal = PrototypeEgressPolicy.canonicalLiteral(host) { return [literal] }
        let addresses: [String]
        do { addresses = try await resolver.addresses(for: host) }
        catch { throw PrototypeRequestError(.network, "Destination resolution failed.") }
        guard !addresses.isEmpty, policy.check(host: host, port: port, addresses: addresses) == .allow else {
            throw PrototypeRequestEgressCheck.blocked
        }
        let literals = addresses.compactMap(PrototypeEgressPolicy.canonicalLiteral)
        guard literals.count == addresses.count else { throw PrototypeRequestEgressCheck.blocked }
        return literals
    }

    private func connect(_ addresses: [String], url: URL) async throws -> any PrototypePinnedConnection {
        var lastError: Error = URLError(.cannotConnectToHost)
        for address in addresses {
            try Task.checkCancellation()
            let connection: any PrototypePinnedConnection
            do {
                connection = try await connector.connect(
                    address: address,
                    port: PrototypeRequestEgressCheck.port(url),
                    tlsServerName: url.scheme?.lowercased() == "https" ? Self
                        .host(url) : nil
                )
            } catch {
                if error is PrototypeLocalNetworkDenied {
                    onLocalNetworkDenied()
                    throw error
                }
                guard Self.canRetryConnection(error) else { throw Self.map(error, url: url.absoluteString) }
                lastError = error
                continue
            }
            guard let remote = connection.remoteAddress, Self.sameAddress(remote, address) else {
                connection.cancel()
                throw PrototypeRequestEgressCheck.blocked
            }
            return connection
        }
        throw Self.map(lastError, url: url.absoluteString)
    }

    private func read(
        _ connection: any PrototypePinnedConnection, request: PrototypeHttpRequest
    )
        async throws -> PrototypeHTTP1Codec.Response
    {
        var codec = PrototypeHTTP1Codec(method: request.method, maxResponseBytes: request.maxResponseBytes)
        while true {
            try Task.checkCancellation()
            let bytes = try await connection.receive(maximumLength: 16 * 1024)
            if let response = try codec.append(bytes, eof: bytes.isEmpty) {
                if !response.body.isEmpty, PrototypeHttpBody.decode(response.body) == .null {
                    throw PrototypeRequestError(
                        .invalidResponse,
                        "A response body of JSON null cannot be stored in /data."
                    )
                }
                return response
            }
        }
    }

    private static func redirect(
        _ request: PrototypeHttpRequest, from previous: URL, to next: URL, status: Int
    )
        -> PrototypeHttpRequest
    {
        let rewrite = (status == 303 && request.method != .head) ||
            ([301, 302].contains(status) && request.method == .post)
        let entityHeaders = [
            "content-type",
            "content-length",
            "content-encoding",
            "content-language",
            "content-location",
        ]
        let headers = request.headers.filter { name, _ in
            if rewrite, entityHeaders.contains(name.lowercased()) { return false }
            return name.lowercased() != "authorization" || PrototypeRequestEgressCheck.sameOrigin(previous, next)
        }
        return PrototypeHttpRequest(
            redirecting: request,
            url: next.absoluteString,
            method: rewrite ? .get : request.method,
            headers: headers,
            dropBody: rewrite
        )
    }

    private func elapsed(since start: Double) -> Int { max(0, Int((nowMs() - start).rounded())) }
    private static func host(_ url: URL) -> String {
        (url.host ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    static func sameAddress(_ lhs: String, _ rhs: String) -> Bool {
        func bytes(_ text: String) -> Data? {
            var ipv4 = in_addr()
            if text
                .withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 { return withUnsafeBytes(of: ipv4) { Data($0) } }
            var ipv6 = in6_addr()
            if text
                .withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 { return withUnsafeBytes(of: ipv6) { Data($0) } }
            return nil
        }
        guard let left = bytes(lhs), let right = bytes(rhs) else { return false }
        return left == right || nat64Embedded(left, equals: right) || nat64Embedded(right, equals: left)
    }

    /// An IPv6-only NAT64 network reports a dialed IPv4 literal as 64:ff9b::/96 (RFC 6052 well-known prefix) plus
    /// that IPv4. The embedded address must equal the checked address, so the connection stays pinned. Other
    /// RFC 6052 prefixes are network-specific and cannot be recognised without trusting an unverified prefix.
    private static let nat64Prefix = Data([0x00, 0x64, 0xFF, 0x9B] + [UInt8](repeating: 0, count: 8))

    private static func nat64Embedded(_ ipv6: Data, equals ipv4: Data) -> Bool {
        ipv6.count == 16 && ipv4.count == 4 && ipv6.prefix(12) == nat64Prefix && ipv6.suffix(4) == ipv4
    }

    /// TLS and protocol failures are terminal; only transport establishment errors try another IP.
    private static func canRetryConnection(_ error: Error) -> Bool {
        if let posix = error as? POSIXError { return posix.code != .ECANCELED }
        guard let code = (error as? URLError)?.code else { return false }
        return [.cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .timedOut].contains(code)
    }

    private static func map(_ error: Error, url: String) -> PrototypeRequestError {
        if error is PrototypeLocalNetworkDenied { return .init(.network, PrototypeLocalNetworkDenied.message) }
        if let error = error as? PrototypeRequestError { return error }
        if (error as? URLError)?.code == .cannotConnectToHost || (error as? POSIXError)?.code == .ECONNREFUSED {
            return .init(.connectionRefused, "Connection refused: \(url)")
        }
        return .init(.network, error.localizedDescription)
    }
}

extension PrototypeHttpRequest {
    /// Redirects retain the original body bytes without decoding and re-encoding author data.
    fileprivate init(
        redirecting request: PrototypeHttpRequest, url: String, method: PrototypeRequestMethod,
        headers: [String: String], dropBody: Bool
    ) {
        self.method = method
        self.url = url
        self.headers = headers
        body = dropBody ? nil : request.body
        timeoutMs = request.timeoutMs
        maxResponseBytes = request.maxResponseBytes
    }
}
