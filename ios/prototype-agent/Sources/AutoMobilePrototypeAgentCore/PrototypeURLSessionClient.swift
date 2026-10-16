import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// The URLSession implementation of `PrototypeHttpClient` (#12529), used for `via: "device"`.
///
/// It owns a dedicated session, never `URLSession.shared`, so the host app's own networking,
/// cookies, cache and credentials are untouched: an ephemeral configuration with no cookie jar or
/// URL cache and the contract's 30 s ceiling. `timeoutMs` is a total deadline enforced here (the
/// URLSession request timeout only bounds idle time), the body is capped as it arrives, and the
/// duration comes from the session's own task metrics when it reports them.
final class PrototypeURLSessionClient: PrototypeHttpClient, @unchecked Sendable {
    private let session: URLSession
    private let delegate: PrototypeURLSessionDelegate
    private let nowMs: @Sendable () -> Double

    /// `protocolClasses` lets a test stub the network with a `URLProtocol`.
    init(
        protocolClasses: [AnyClass]? = nil,
        nowMs: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
    ) {
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
        let delegate = PrototypeURLSessionDelegate()
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "dev.jasonpearson.automobile.prototype-agent.request"
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
        self.delegate = delegate
        self.nowMs = nowMs
    }

    deinit {
        session.invalidateAndCancel()
    }

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        let started = nowMs()
        guard let urlRequest = Self.urlRequest(for: request) else {
            throw PrototypeHttpFailure(error: .init(.invalidURL, "Not an absolute URL: \(request.url)"), durationMs: 0)
        }
        let task = session.dataTask(with: urlRequest)
        let call = PrototypeURLSessionCall(
            maxBytes: request.maxResponseBytes, timeoutMs: request.timeoutMs, url: request.url
        )
        let handle = PrototypeURLSessionTaskHandle(task)
        do {
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    call.install(continuation)
                    delegate.register(call, for: handle)
                    call.armDeadline(cancelling: handle)
                    if Task.isCancelled { call.cancelByCaller(handle) }
                    task.resume()
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

    static func urlRequest(for request: PrototypeHttpRequest) -> URLRequest? {
        guard let url = URL(string: request.url) else { return nil }
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
    private var tooLarge = false
    private var timedOut = false
    private var cancelledByCaller = false
    private var deadline: DispatchWorkItem?

    init(maxBytes: Int, timeoutMs: Int, url: String) {
        self.maxBytes = maxBytes
        self.timeoutMs = timeoutMs
        self.url = url
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

    /// Whether the headers announce a body over the cap, which ends the call before it is read.
    func accept(status: Int, headers: [String: String], expectedLength: Int64) -> Bool {
        lock.withLock {
            self.status = status
            self.headers = headers
            if expectedLength > Int64(maxBytes) { tooLarge = true }
            return !tooLarge
        }
    }

    /// False once the body crossed the cap.
    func append(_ data: Data) -> Bool {
        lock.withLock {
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
                if tooLarge || error != nil {
                    let mapped = PrototypeURLErrorMapping.map(
                        error ?? URLError(.cancelled), url: url, timeoutMs: timeoutMs, timedOut: timedOut,
                        tooLarge: tooLarge, cancelledByCaller: cancelledByCaller, maxBytes: maxBytes
                    )
                    return (continuation, .failure(PrototypeHttpFailure(error: mapped, durationMs: durationMs)))
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
        let seconds = metrics.taskInterval.duration
        if seconds > 0 { call(for: task)?.record(metricsMs: Int((seconds * 1000).rounded())) }
    }

    func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (call, start) = lock.withLock { (
            calls.removeValue(forKey: task.taskIdentifier),
            starts.removeValue(forKey: task.taskIdentifier)
        ) }
        let measured = start.map { max(0, Int((ProcessInfo.processInfo.systemUptime * 1000 - $0).rounded())) } ?? 0
        call?.finish(error: error, measuredMs: measured)
    }
}
