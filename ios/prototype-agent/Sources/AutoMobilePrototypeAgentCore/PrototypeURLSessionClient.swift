import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// The URLSession implementation of `PrototypeHttpClient` (#12529), used for `via: "device"`.
///
/// It owns a dedicated session, never `URLSession.shared`, so the host app's own networking,
/// cookies, cache and credentials are untouched: an ephemeral configuration with no cookie jar or
/// URL cache and the contract's 30 s ceiling. `timeoutMs` is a total deadline enforced here (the
/// URLSession request timeout only bounds idle time), a 2xx body is capped as it arrives (a non-2xx
/// body is never read), and the duration comes from the session's own task metrics when it reports
/// them.
final class PrototypeURLSessionClient: PrototypeHttpClient, @unchecked Sendable {
    private let session: URLSession
    private let delegate: PrototypeURLSessionDelegate
    private let egress: PrototypeRequestEgressCheck
    private let nowMs: @Sendable () -> Double

    /// `protocolClasses` lets a test stub the network with a `URLProtocol`.
    init(
        protocolClasses: [AnyClass]? = nil,
        policy: PrototypeEgressPolicy = PrototypeEgressPolicy(),
        resolver: any HostResolving = PrototypeSystemHostResolver(),
        metrics: any PrototypeConnectionMetricsProviding = PrototypeConnectionMetrics(),
        nowMs: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
    ) {
        let configuration = Self.configuration(protocolClasses: protocolClasses)
        let egress = PrototypeRequestEgressCheck(policy: policy, resolver: resolver)
        let delegate = PrototypeURLSessionDelegate(egress: egress, metrics: metrics)
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "dev.jasonpearson.automobile.prototype-agent.request"
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
        self.delegate = delegate
        self.egress = egress
        self.nowMs = nowMs
    }

    static func configuration(protocolClasses: [AnyClass]? = nil) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        let ceiling = Double(PrototypeLimits.maxRequestTimeoutMs) / 1000
        configuration.timeoutIntervalForRequest = ceiling
        configuration.timeoutIntervalForResource = ceiling
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpMaximumConnectionsPerHost = PrototypeLimits.maxRequestsInFlight
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        configuration.connectionProxyDictionary = [:]
        return configuration
    }

    deinit {
        session.invalidateAndCancel()
    }

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        let started = nowMs()
        if let problem = PrototypeHttpHeaderCheck.problem(in: request.headers) {
            throw PrototypeHttpFailure(error: problem, durationMs: 0)
        }
        guard let urlRequest = Self.urlRequest(for: request) else {
            throw PrototypeHttpFailure(error: .init(.invalidURL, "Not an absolute URL: \(request.url)"), durationMs: 0)
        }
        let task = session.dataTask(with: urlRequest)
        let call = PrototypeURLSessionCall(
            maxBytes: request.maxResponseBytes, timeoutMs: request.timeoutMs, request: urlRequest
        )
        let handle = PrototypeURLSessionTaskHandle(task)
        do {
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    call.install(continuation)
                    delegate.register(call, for: handle)
                    call.armDeadline(cancelling: handle)
                    if Task.isCancelled { call.cancelByCaller(handle) }
                    // DNS suspends here while a bounded worker resolves. A late answer cannot
                    // resume a call stopped by its total deadline or caller cancellation.
                    Task { [egress] in
                        guard call.canProceed else { return }
                        do {
                            try await egress.validate(urlRequest)
                            if call.canProceed { task.resume() }
                        } catch {
                            call.reject(Self.preflightError(error))
                            handle.cancel()
                        }
                    }
                }
            } onCancel: {
                call.cancelByCaller(handle)
            }
        } catch let failure as PrototypeHttpFailure {
            // The delegate has no clock; a failure without the session's own timing is measured here.
            let elapsed = max(0, Int((nowMs() - started).rounded()))
            throw PrototypeHttpFailure(
                error: failure.error,
                durationMs: failure.durationMs == 0 ? elapsed : failure.durationMs
            )
        }
    }

    private static func preflightError(_ error: Error) -> PrototypeRequestError {
        if let error = error as? PrototypeRequestError { return error }
        return .init(.network, "Destination resolution failed.")
    }

    static func urlRequest(for request: PrototypeHttpRequest) -> URLRequest? {
        guard let url = URL(string: request.url), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else { return nil }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.timeoutInterval = Double(request.timeoutMs) / 1000
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.httpShouldHandleCookies = false
        for (name, value) in request.headers.sorted(by: { $0.key < $1.key }) {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        urlRequest.httpBody = request.body
        return urlRequest
    }
}

// MARK: Error mapping

/// URLSession errors as the request contract's typed codes. Pure, so it is tested without a network.
enum PrototypeURLErrorMapping {
    /// `NSURLErrorAppTransportSecurityRequiresSecureConnection`.
    static let appTransportSecurityCode = -1022

    static let appTransportSecurityMessage =
        "App Transport Security blocked this cleartext http:// request, because the app this prototype runs in " +
        "does not allow insecure HTTP loads (localhost and IP addresses are exempt). Use via \"host\", which the " +
        "AutoMobile host runs without that restriction, or an https:// URL."

    static func map(
        _ error: Error,
        url: String,
        timeoutMs: Int,
        timedOut: Bool,
        tooLarge: Bool,
        cancelledByCaller: Bool,
        maxBytes: Int
    )
        -> PrototypeRequestError
    {
        if tooLarge { return .init(.tooLarge, "Response body exceeds \(maxBytes) bytes.") }
        if timedOut { return .init(.timeout, "Request timed out after \(timeoutMs)ms.") }
        if cancelledByCaller { return .init(.cancelled, "Request was cancelled.") }
        // Darwin delivers a URLError; swift-corelibs may deliver the bare NSError of the same domain.
        let nsError = error as NSError
        guard error is URLError || nsError.domain == NSURLErrorDomain else {
            return .init(.network, error.localizedDescription)
        }
        switch nsError.code {
        case URLError.Code.timedOut.rawValue: return .init(.timeout, "Request timed out after \(timeoutMs)ms.")
        case URLError.Code.cancelled.rawValue: return .init(.cancelled, "Request was cancelled.")
        case URLError.Code.cannotConnectToHost.rawValue: return .init(.connectionRefused, "Connection refused: \(url)")
        case URLError.Code.badURL.rawValue, URLError.Code.unsupportedURL.rawValue:
            return .init(.invalidURL, "Not an absolute URL: \(url)")
        case appTransportSecurityCode: return .init(.network, appTransportSecurityMessage)
        default: return .init(.network, error.localizedDescription)
        }
    }
}

// MARK: Session plumbing

/// URLSessionTask is not Sendable; the handle crosses into the cancellation handler, where the
/// only call made is the thread-safe `cancel()`.
final class PrototypeURLSessionTaskHandle: @unchecked Sendable {
    let task: URLSessionTask
    init(_ task: URLSessionTask) { self.task = task }
    var identifier: Int { task.taskIdentifier }
    func cancel() { task.cancel() }
}

/// One call's collected state. Mutated from the delegate queue, the deadline timer and the
/// caller's cancellation, so every access takes the lock.
final class PrototypeURLSessionCall: @unchecked Sendable {
    private let lock = NSLock()
    private let maxBytes: Int
    private let timeoutMs: Int
    private let url: String
    private var continuation: CheckedContinuation<PrototypeHttpResponse, Error>?
    private var body = Data()
    private var status = 0
    private var headers: [String: String] = [:]
    private var metricsMs: Int?
    private var inspectedMetrics = false
    private var policyError: PrototypeRequestError?
    private var currentRequest: URLRequest
    private var redirectCount = 0
    private var tooLarge = false
    /// A non-2xx status ends the call at the headers: the outcome is `http_error`, so its body is
    /// never read and the size cap does not apply to it.
    private var skippedBody = false
    private var timedOut = false
    private var cancelledByCaller = false
    private var deadline: DispatchWorkItem?

    init(maxBytes: Int, timeoutMs: Int, request: URLRequest) {
        self.maxBytes = maxBytes
        self.timeoutMs = timeoutMs
        url = request.url?.absoluteString ?? ""
        currentRequest = request
    }

    var canProceed: Bool {
        lock.withLock { continuation != nil && !timedOut && !cancelledByCaller && policyError == nil }
    }

    func reject(_ error: PrototypeRequestError = PrototypeRequestEgressCheck.blocked) {
        lock.withLock {
            policyError = error
            body.removeAll()
        }
    }

    func inspectConnection(address: String, url: URL, port: Int?, egress: PrototypeRequestEgressCheck) -> Bool {
        guard egress.checkConnected(address: address, url: url, port: port) else {
            reject()
            return false
        }
        return true
    }

    func inspectMetrics(_ transactions: [PrototypeConnectionMetric], egress: PrototypeRequestEgressCheck) -> Bool {
        lock.withLock { inspectedMetrics = true }
        var networkLoad = false
        for transaction in transactions {
            if transaction.isProxyConnection { reject(); return false }
            guard transaction.isNetworkLoad else { continue }
            networkLoad = true
            guard let address = transaction.remoteAddress, let url = transaction.url,
                  inspectConnection(address: address, url: url, port: transaction.remotePort, egress: egress)
            else { reject(); return false }
        }
        if !networkLoad { reject() }
        return networkLoad
    }

    func inspectMissingMetrics(
        using provider: any PrototypeConnectionMetricsProviding, egress: PrototypeRequestEgressCheck
    ) {
        let needsMetrics = lock.withLock { status != 0 && !inspectedMetrics }
        if needsMetrics { _ = inspectMetrics(provider.transactions(for: nil), egress: egress) }
    }

    /// Builds redirects from the previous authored request rather than trusting Foundation's
    /// proposed method, body or credentials. Only the proposed URL is used.
    func redirect(to url: URL, status: Int, egress: PrototypeRequestEgressCheck) async throws -> URLRequest {
        var next = try lock.withLock {
            guard redirectCount < 5, let previous = currentRequest.url,
                  !(previous.scheme?.lowercased() == "https" && url.scheme?.lowercased() == "http")
            else {
                throw PrototypeRequestEgressCheck.blocked
            }
            redirectCount += 1
            var next = currentRequest
            next.url = url
            if !PrototypeRequestEgressCheck.sameOrigin(previous, url) {
                next.setValue(nil, forHTTPHeaderField: "Authorization")
            }
            return next
        }
        // Fetch's rule, matching the host executor: POST becomes GET on 301/302, any method but
        // HEAD becomes GET on 303, and 307/308 keep the method and body.
        let method = next.httpMethod ?? "GET"
        if (status == 303 && method != "HEAD") || ([301, 302].contains(status) && method == "POST") {
            next.httpMethod = "GET"
            next.httpBody = nil
            next.httpBodyStream = nil
            for name in ["Content-Type", "Content-Length", "Content-Encoding", "Content-Language", "Content-Location"] {
                next.setValue(nil, forHTTPHeaderField: name)
            }
        }
        try await egress.validate(next)
        lock.withLock { currentRequest = next }
        return next
    }

    func install(_ continuation: CheckedContinuation<PrototypeHttpResponse, Error>) {
        lock.withLock { self.continuation = continuation }
    }

    /// Cancels the task when the total deadline passes; `timeoutMs` bounds the whole call.
    func armDeadline(cancelling handle: PrototypeURLSessionTaskHandle) {
        let item = DispatchWorkItem { [self] in
            lock.withLock { timedOut = true }
            handle.cancel()
        }
        lock.withLock { deadline = item }
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: item)
    }

    func cancelByCaller(_ handle: PrototypeURLSessionTaskHandle) {
        lock.withLock { cancelledByCaller = true }
        handle.cancel()
    }

    /// Whether the body should be read: a non-2xx status never is, and a 2xx body whose headers
    /// announce more than the cap ends the call before it is read.
    func accept(status: Int, headers: [String: String], expectedLength: Int64) -> Bool {
        lock.withLock {
            self.status = status
            self.headers = headers
            if status < 200 || status > 299 {
                skippedBody = true
                return false
            }
            if expectedLength > Int64(maxBytes) { tooLarge = true }
            return !tooLarge
        }
    }

    /// False once the body crossed the cap (or was skipped).
    func append(_ data: Data) -> Bool {
        lock.withLock {
            // A cancelled non-2xx body can still deliver chunks; none of it is kept or counted.
            if skippedBody || policyError != nil { return false }
            body.append(data)
            if body.count > maxBytes { tooLarge = true }
            return !tooLarge
        }
    }

    func record(metricsMs: Int) {
        lock.withLock { self.metricsMs = metricsMs }
    }

    func finish(error: Error?, measuredMs: Int) {
        let outcome: (
            CheckedContinuation<PrototypeHttpResponse, Error>?,
            Result<PrototypeHttpResponse, PrototypeHttpFailure>
        ) =
            lock.withLock {
                deadline?.cancel()
                let continuation = self.continuation
                self.continuation = nil
                let durationMs = metricsMs ?? measuredMs
                // The caller's cancel and the total deadline outrank a policy rejection that races
                // them, so a late DNS, redirect or metrics refusal cannot turn the promised
                // `cancelled` or `timeout` into `blocked_destination` or `network` (#14557).
                let interrupted = timedOut || cancelledByCaller
                if let policyError, !interrupted {
                    return (continuation, .failure(PrototypeHttpFailure(error: policyError, durationMs: durationMs)))
                }
                // Cancelling a non-2xx body ends the task with a cancel error that is ours, not a failure.
                let skipped = skippedBody && !interrupted
                if tooLarge || policyError != nil || (error != nil && !skipped) {
                    let mapped = PrototypeURLErrorMapping.map(
                        error ?? URLError(.cancelled), url: url, timeoutMs: timeoutMs, timedOut: timedOut,
                        tooLarge: tooLarge, cancelledByCaller: cancelledByCaller, maxBytes: maxBytes
                    )
                    return (continuation, .failure(PrototypeHttpFailure(error: mapped, durationMs: durationMs)))
                }
                // `null` means "empty body" downstream, so a JSON `null` body cannot be stored.
                if (200 ..< 300).contains(status), !body.isEmpty, PrototypeHttpBody.decode(body) == .null {
                    let literalNull = PrototypeRequestError(
                        .invalidResponse, "A response body of JSON null cannot be stored in /data."
                    )
                    return (continuation, .failure(PrototypeHttpFailure(error: literalNull, durationMs: durationMs)))
                }
                return (continuation, .success(PrototypeHttpResponse(
                    status: status, headers: headers, body: body, durationMs: durationMs
                )))
            }
        outcome.0?.resume(with: outcome.1.mapError { $0 as Error })
    }
}

final class PrototypeURLSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [Int: PrototypeURLSessionCall] = [:]
    private var starts: [Int: Double] = [:]
    private let egress: PrototypeRequestEgressCheck

    private let metrics: any PrototypeConnectionMetricsProviding

    init(egress: PrototypeRequestEgressCheck, metrics: any PrototypeConnectionMetricsProviding) {
        self.egress = egress
        self.metrics = metrics
    }

    func register(_ call: PrototypeURLSessionCall, for handle: PrototypeURLSessionTaskHandle) {
        lock.withLock {
            calls[handle.identifier] = call
            starts[handle.identifier] = ProcessInfo.processInfo.systemUptime * 1000
        }
    }

    private func call(for task: URLSessionTask) -> PrototypeURLSessionCall? {
        lock.withLock { calls[task.taskIdentifier] }
    }

    func urlSession(
        _: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        guard let call = call(for: task), let url = request.url else { return completionHandler(nil) }
        Task { [egress] in
            do {
                let next = try await call.redirect(to: url, status: response.statusCode, egress: egress)
                completionHandler(call.canProceed ? next : nil)
            } catch {
                call.reject()
                completionHandler(nil)
                task.cancel()
            }
        }
    }

    func urlSession(
        _: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let call = call(for: dataTask) else { return completionHandler(.cancel) }
        let http = response as? HTTPURLResponse
        let headers = (http?.allHeaderFields ?? [:]).reduce(into: [String: String]()) { result, field in
            if let name = field.key as? String, let value = field.value as? String {
                result[name.lowercased()] = value
            }
        }
        let accepted = call.accept(
            status: http?.statusCode ?? 0, headers: headers, expectedLength: response.expectedContentLength
        )
        completionHandler(accepted ? .allow : .cancel)
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let call = call(for: dataTask) else { return }
        if !call.append(data) { dataTask.cancel() }
    }

    func urlSession(_: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        if let call = call(for: task), !call.inspectMetrics(self.metrics.transactions(for: metrics), egress: egress) {
            task.cancel()
        }
        let seconds = metrics.taskInterval.duration
        if seconds > 0 { call(for: task)?.record(metricsMs: Int((seconds * 1000).rounded())) }
    }

    func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (call, start) = lock.withLock {
            let call = calls.removeValue(forKey: task.taskIdentifier)
            let start = starts.removeValue(forKey: task.taskIdentifier)
            return (call, start)
        }
        let measured = start.map { max(0, Int((ProcessInfo.processInfo.systemUptime * 1000 - $0).rounded())) } ?? 0
        call?.inspectMissingMetrics(using: metrics, egress: egress)
        call?.finish(error: error, measuredMs: measured)
    }
}
