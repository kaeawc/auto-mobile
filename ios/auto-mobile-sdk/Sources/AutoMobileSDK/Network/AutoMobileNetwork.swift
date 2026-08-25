import Foundation

/// Grouped parameters for recording a network request/response manually.
///
/// Use this struct with ``AutoMobileNetwork/recordRequest(_:)`` instead of
/// passing individual parameters.
public struct NetworkRequestRecord: Sendable {
    /// Stable identifier for this request lifecycle.
    public var requestId: String?
    /// Identifier shared by requests on the same transport connection.
    public var connectionId: String?
    /// Direction or lifecycle protocol represented by this record.
    public var direction: NetworkCaptureDirection?
    /// Transport name, such as `http`, `websocket`, or `nwconnection`.
    public var protocolName: String?
    /// Adapter-supplied lifecycle metadata such as redirect and auth details.
    public var metadata: [String: String]?
    /// Monotonic recorder order assigned when the event is emitted.
    public var sequenceNumber: UInt64?
    /// The full request URL (e.g. "https://api.example.com/users?page=1").
    public let url: String
    /// HTTP method (e.g. "GET", "POST").
    public let method: String
    /// Request headers. Only recorded when header capture is enabled.
    public var requestHeaders: [String: String]?
    /// Size of the request body in bytes.
    public var requestBodySize: Int?
    /// HTTP status code of the response (e.g. 200, 404).
    public var statusCode: Int?
    /// Response headers. Only recorded when header capture is enabled.
    public var responseHeaders: [String: String]?
    /// Size of the response body in bytes.
    public var responseBodySize: Int?
    /// Round-trip duration in milliseconds.
    public var durationMs: Double?
    /// Error description if the request failed.
    public var error: String?
    /// Request body text. Only recorded when body capture is enabled and content is text-based.
    public var requestBody: String?
    /// Response body text. Only recorded when body capture is enabled and content is text-based.
    public var responseBody: String?
    /// Content type of the response (e.g. "application/json").
    public var contentType: String?

    public init(
        url: String,
        method: String,
        requestId: String? = nil,
        connectionId: String? = nil,
        direction: NetworkCaptureDirection? = nil,
        protocolName: String? = nil,
        metadata: [String: String]? = nil,
        sequenceNumber: UInt64? = nil,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil,
        statusCode: Int? = nil,
        responseHeaders: [String: String]? = nil,
        responseBodySize: Int? = nil,
        durationMs: Double? = nil,
        error: String? = nil,
        requestBody: String? = nil,
        responseBody: String? = nil,
        contentType: String? = nil
    ) {
        self.requestId = requestId
        self.connectionId = connectionId
        self.direction = direction
        self.protocolName = protocolName
        self.metadata = metadata
        self.sequenceNumber = sequenceNumber
        self.url = url
        self.method = method
        self.requestHeaders = requestHeaders
        self.requestBodySize = requestBodySize
        self.statusCode = statusCode
        self.responseHeaders = responseHeaders
        self.responseBodySize = responseBodySize
        self.durationMs = durationMs
        self.error = error
        self.requestBody = requestBody
        self.responseBody = responseBody
        self.contentType = contentType
    }
}

/// Network request/response tracking for URLSession.
/// iOS equivalent of Android's OkHttp interceptor.
///
/// Use ``protocolClass()`` to register automatic interception with `URLSessionConfiguration`,
/// or call ``recordRequest(_:)`` to record requests manually.
public final class AutoMobileNetwork: @unchecked Sendable {
    public static let shared = AutoMobileNetwork()
    private static let defaultMaxBodyBytes = 32 * 1024

    private let lock = NSLock()
    private var bundleId: String?
    private var buffer: SdkEventBuffer?
    private var _isEnabled = true
    private var _captureHeaders = false
    private var _captureBodies = false
    // Leading-underscore backing field is internal (not private) for URLProtocol access.
    // swiftlint:disable:next identifier_name
    var _maxBodyBytes: Int = AutoMobileNetwork.defaultMaxBodyBytes // 32KB default (internal for URLProtocol access)

    /// Thread-safe read of maxBodyBytes for URLProtocol callbacks.
    var maxBodyBytes: Int {
        lock.lock()
        defer { lock.unlock() }
        return _maxBodyBytes
    }

    /// Byte limit for request body capture, or nil when capture is disabled.
    var requestBodyCaptureLimit: Int? {
        lock.lock()
        defer { lock.unlock() }
        guard _captureBodies, _maxBodyBytes > 0 else {
            return nil
        }
        return _maxBodyBytes
    }

    /// Text content types eligible for body capture.
    static let textContentTypes: Set<String> = [
        "application/json", "text/plain", "text/html", "text/xml",
        "application/xml", "application/x-www-form-urlencoded",
    ]

    /// Check if a content type is text-based and eligible for body capture.
    public static func isTextContentType(_ contentType: String?) -> Bool {
        guard let ct = contentType else { return false }
        let base = ct.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        return textContentTypes.contains(base) || base.hasPrefix("text/")
    }

    private init() {}

    // MARK: - Enable/Disable

    /// Whether network tracking is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable network tracking.
    /// When disabled, recordRequest and recordWebSocketFrame short-circuit.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        lock.unlock()
    }

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        lock.lock()
        self.bundleId = bundleId
        self.buffer = buffer
        lock.unlock()
    }

    /// Configure whether to capture request/response headers.
    public func setCaptureHeaders(_ capture: Bool) {
        lock.lock()
        _captureHeaders = capture
        lock.unlock()
    }

    /// Configure whether to capture request/response bodies.
    /// In release builds, body capture is always disabled to prevent leaking
    /// auth tokens, credentials, or PII.
    public func setCaptureBodies(_ capture: Bool) {
        #if DEBUG
        lock.lock()
        _captureBodies = capture
        lock.unlock()
        #endif
    }

    /// Configure maximum body bytes to capture (default: 32KB).
    /// Values <= 0 disable body capture truncation (uses 0, meaning no capture).
    public func setMaxBodyBytes(_ bytes: Int) {
        lock.lock()
        _maxBodyBytes = max(0, bytes)
        lock.unlock()
    }

    /// Returns the `URLProtocol` subclass that intercepts and records network requests.
    ///
    /// Register the returned class with your `URLSessionConfiguration`:
    /// ```swift
    /// let config = URLSessionConfiguration.default
    /// config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
    /// let session = URLSession(configuration: config)
    /// ```
    ///
    /// - Returns: A `URLProtocol` subclass suitable for `protocolClasses`.
    public func protocolClass() -> AnyClass {
        return AutoMobileURLProtocol.self
    }

    /// Creates a recorder for custom transports that cannot install a URLProtocol.
    public func captureRecorder() -> NetworkCaptureRecorder {
        NetworkCaptureRecorder(
            emit: { [weak self] record in
                self?.recordRequest(record)
            },
            maxBodyBytes: maxBodyBytes,
            isEnabled: { [weak self] in
                self?.isEnabled ?? false
            },
            isBodyCaptureEnabled: { [weak self] in
                self?.requestBodyCaptureLimit != nil
            }
        )
    }

    /// Record a network request/response manually using a ``NetworkRequestRecord``.
    ///
    /// Use this when you cannot use the ``protocolClass()`` approach (e.g. custom
    /// transport layers, gRPC, or GraphQL clients).
    ///
    /// - Parameter record: A ``NetworkRequestRecord`` describing the request and response.
    public func recordRequest(_ record: NetworkRequestRecord) {
        guard AutoMobileSDK.shared.isEnabled else { return }

        lock.lock()
        guard _isEnabled else {
            lock.unlock()
            return
        }
        let captureHeaders = _captureHeaders
        let captureBodies = _captureBodies
        let maxBytes = _maxBodyBytes
        let currentBuffer = buffer
        lock.unlock()

        // Truncate bodies if needed
        let finalRequestBody: String? = captureBodies ? record.requestBody.map { truncateBody($0, maxBytes: maxBytes) } : nil
        let finalResponseBody: String? = captureBodies ? record.responseBody.map { truncateBody($0, maxBytes: maxBytes) } : nil

        // Extract host and path from URL
        let urlComponents = URLComponents(string: record.url)

        let event = SdkNetworkRequestEvent(
            url: record.url,
            method: record.method,
            requestId: record.requestId,
            connectionId: record.connectionId,
            direction: record.direction,
            protocolName: record.protocolName,
            metadata: record.metadata,
            sequenceNumber: record.sequenceNumber,
            requestHeaders: captureHeaders ? record.requestHeaders : nil,
            requestBodySize: record.requestBodySize,
            statusCode: record.statusCode,
            responseHeaders: captureHeaders ? record.responseHeaders : nil,
            responseBodySize: record.responseBodySize,
            durationMs: record.durationMs,
            error: record.error,
            host: urlComponents?.host,
            path: urlComponents?.path,
            requestBody: finalRequestBody,
            responseBody: finalResponseBody,
            contentType: record.contentType
        )
        currentBuffer?.add(event)
    }

    /// Record a network request/response manually.
    ///
    /// Prefer ``recordRequest(_:)`` with a ``NetworkRequestRecord`` for cleaner call sites.
    @available(*, deprecated, message: "Use recordRequest(_:) with NetworkRequestRecord instead")
    public func recordRequest(
        url: String,
        method: String,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil,
        statusCode: Int? = nil,
        responseHeaders: [String: String]? = nil,
        responseBodySize: Int? = nil,
        durationMs: Double? = nil,
        error: String? = nil,
        requestBody: String? = nil,
        responseBody: String? = nil,
        contentType: String? = nil
    ) {
        recordRequest(NetworkRequestRecord(
            url: url,
            method: method,
            requestHeaders: requestHeaders,
            requestBodySize: requestBodySize,
            statusCode: statusCode,
            responseHeaders: responseHeaders,
            responseBodySize: responseBodySize,
            durationMs: durationMs,
            error: error,
            requestBody: requestBody,
            responseBody: responseBody,
            contentType: contentType
        ))
    }

    private func truncateBody(_ body: String, maxBytes: Int) -> String {
        if body.utf8.count <= maxBytes { return body }
        // Truncate to maxBytes, respecting UTF-8 character boundaries
        let utf8 = body.utf8
        let truncatedBytes = utf8.prefix(maxBytes)
        // Walk backwards to find a valid UTF-8 boundary
        var endIndex = truncatedBytes.endIndex
        while endIndex > truncatedBytes.startIndex {
            if let result = String(utf8[truncatedBytes.startIndex..<endIndex]) {
                return result
            }
            endIndex = utf8.index(before: endIndex)
        }
        return ""
    }

    /// Decode data as UTF-8, walking backwards if truncated mid-character.
    static func utf8String(from data: Data) -> String? {
        if let str = String(data: data, encoding: .utf8) { return str }
        // Walk backwards to find a valid UTF-8 boundary
        var length = data.count
        while length > 0 {
            length -= 1
            if let str = String(data: data.prefix(length), encoding: .utf8) {
                return str
            }
        }
        return nil
    }

    /// Record a completed network task from `URLSessionDelegate` callbacks.
    ///
    /// This is the recommended integration path for apps that already have their
    /// own `URLSession` delegate or a competing `URLProtocol` chain. It avoids
    /// the conflicts that arise when multiple `URLProtocol` subclasses are
    /// registered on the same session.
    ///
    /// Call this from your delegate's completion handler:
    /// ```swift
    /// func urlSession(_ session: URLSession, task: URLSessionTask,
    ///                 didCompleteWithError error: Error?) {
    ///     AutoMobileNetwork.shared.recordFromTask(
    ///         task,
    ///         startTime: taskStartTimes[task]!,
    ///         receivedData: taskData[task],
    ///         error: error
    ///     )
    /// }
    /// ```
    ///
    /// - Parameters:
    ///   - task: The completed `URLSessionTask`.
    ///   - startTime: When the task started, used to compute `durationMs`.
    ///   - receivedData: Accumulated response body data, if the delegate buffered it.
    ///   - error: The task's completion error, if any.
    public func recordFromTask(
        _ task: URLSessionTask,
        startTime: Date,
        receivedData: Data?,
        error: Error?
    ) {
        let durationMs = Date().timeIntervalSince(startTime) * 1000
        let originalRequest = task.originalRequest
        let url = originalRequest?.url?.absoluteString ?? task.currentRequest?.url?.absoluteString ?? ""
        let method = originalRequest?.httpMethod ?? task.currentRequest?.httpMethod ?? "GET"

        if let error = error {
            recordRequest(NetworkRequestRecord(
                url: url,
                method: method,
                requestHeaders: originalRequest?.allHTTPHeaderFields,
                requestBodySize: originalRequest?.httpBody?.count ?? Int(task.countOfBytesSent),
                durationMs: durationMs,
                error: error.localizedDescription
            ))
            return
        }

        let httpResponse = task.response as? HTTPURLResponse
        let contentType = httpResponse?.value(forHTTPHeaderField: "Content-Type")

        let maxBytes = maxBodyBytes
        let requestBody: String? = originalRequest?.httpBody.flatMap { data in
            AutoMobileNetwork.isTextContentType(originalRequest?.value(forHTTPHeaderField: "Content-Type"))
                ? AutoMobileNetwork.utf8String(from: data.prefix(maxBytes))
                : nil
        }

        let responseBody: String? = {
            guard let data = receivedData, !data.isEmpty,
                  AutoMobileNetwork.isTextContentType(contentType) else { return nil }
            return AutoMobileNetwork.utf8String(from: data.prefix(maxBytes))
        }()

        let responseBodySize: Int? = {
            if let data = receivedData { return data.count }
            let received = Int(task.countOfBytesReceived)
            return received > 0 ? received : nil
        }()

        recordRequest(NetworkRequestRecord(
            url: url,
            method: method,
            requestHeaders: originalRequest?.allHTTPHeaderFields,
            requestBodySize: originalRequest?.httpBody?.count ?? (task.countOfBytesSent > 0 ? Int(task.countOfBytesSent) : nil),
            statusCode: httpResponse?.statusCode,
            responseHeaders: httpResponse?.allHeaderFields as? [String: String],
            responseBodySize: responseBodySize,
            durationMs: durationMs,
            requestBody: requestBody,
            responseBody: responseBody,
            contentType: contentType
        ))
    }

    /// Record a WebSocket frame event.
    ///
    /// - Parameters:
    ///   - url: The WebSocket URL (e.g. "wss://ws.example.com/feed").
    ///   - direction: Whether the frame was sent or received.
    ///   - frameType: The type of WebSocket frame (text, binary, ping, etc.).
    ///   - payloadSize: Optional payload size in bytes.
    public func recordWebSocketFrame(
        url: String,
        direction: WebSocketFrameDirection,
        frameType: WebSocketFrameType,
        payloadSize: Int? = nil
    ) {
        guard AutoMobileSDK.shared.isEnabled else { return }

        lock.lock()
        guard _isEnabled else {
            lock.unlock()
            return
        }
        let currentBuffer = buffer
        lock.unlock()

        let event = SdkWebSocketFrameEvent(
            url: url,
            direction: direction,
            frameType: frameType,
            payloadSize: payloadSize
        )
        currentBuffer?.add(event)
    }

    // MARK: - Testing Support

    internal func reset() {
        lock.lock()
        bundleId = nil
        buffer = nil
        _isEnabled = true
        _captureHeaders = false
        _captureBodies = false
        _maxBodyBytes = AutoMobileNetwork.defaultMaxBodyBytes
        lock.unlock()
    }
}

// MARK: - URLProtocol Implementation

/// A URLProtocol subclass that intercepts network requests for monitoring.
///
/// This is an implementation detail -- consumers should register it via
/// ``AutoMobileNetwork/protocolClass()`` rather than referencing this type directly.
public class AutoMobileURLProtocol: URLProtocol {
    private static let handledKey = "dev.jasonpearson.automobile.sdk.handled"
    private var startTime: Date?
    private var urlSession: URLSession?
    private var dataTask: URLSessionDataTask?
    private var receivedResponse: URLResponse?
    private var receivedData = Data()
    private var totalBytesReceived = 0
    /// Guards the delayed-fault lifecycle across `stopLoading()` (called by the URL
    /// loading system) and the global-queue timer block that serves a delayed fault.
    private let faultLock = NSLock()
    private var stopped = false
    private var faultWorkItem: DispatchWorkItem?

    private static let supportedSchemes: Set<String> = ["http", "https"]

    public override class func canInit(with request: URLRequest) -> Bool {
        guard let scheme = request.url?.scheme?.lowercased(),
              supportedSchemes.contains(scheme),
              URLProtocol.property(forKey: handledKey, in: request) == nil else {
            return false
        }
        return true
    }

    public override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    public override func startLoading() {
        startTime = Date()
        receivedData = Data()
        totalBytesReceived = 0

        #if DEBUG
        if AutoMobileSDK.shared.isEnabled,
           let url = request.url,
           let fault = NetworkMockRuleStore.shared.evaluate(
               NetworkMockRuleStore.FaultRequest(
                   transport: .urlSession,
                   host: url.host,
                   port: url.port,
                   scheme: url.scheme,
                   path: url.path,
                   method: request.httpMethod ?? "GET",
                   headers: request.allHTTPHeaderFields ?? [:],
                   origin: request.value(forHTTPHeaderField: "Origin"),
                   connectionId: nil,
                   sessionId: nil
               )
           ),
           !fault.dryRun
        {
            if let delayMs = fault.delayMs, delayMs > 0 {
                // Schedule as a cancellable work item stored on the protocol so
                // stopLoading() can cancel it — otherwise the timer fires serveFault()
                // (client callbacks) after the protocol has been torn down.
                let workItem = DispatchWorkItem { [weak self] in
                    self?.serveFault(fault, url: url)
                }
                faultLock.lock()
                faultWorkItem = workItem
                faultLock.unlock()
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: workItem)
            } else {
                serveFault(fault, url: url)
            }
            return
        }

        if AutoMobileSDK.shared.isEnabled,
           let url = request.url,
           let match = NetworkMockRuleStore.shared.findMatchingRule(
               host: url.host ?? "",
               path: url.path,
               method: request.httpMethod ?? "GET"
           )
        {
            let body = Data(match.responseBody.utf8)
            var headers = match.responseHeaders
            headers["Content-Type"] = match.contentType
            // HTTPURLResponse(url:statusCode:...) only fails on a nil-ish URL; `url`
            // is a valid request URL and any Int statusCode is accepted.
            let response = HTTPURLResponse(
                url: url,
                statusCode: match.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!  // swiftlint:disable:this force_unwrapping
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !body.isEmpty {
                client?.urlProtocol(self, didLoad: body)
            }
            client?.urlProtocolDidFinishLoading(self)
            AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
                url: url.absoluteString,
                method: request.httpMethod ?? "GET",
                requestHeaders: request.allHTTPHeaderFields,
                requestBodySize: request.httpBody?.count,
                statusCode: match.statusCode,
                responseHeaders: headers,
                responseBodySize: body.count,
                durationMs: startTime.map { Date().timeIntervalSince($0) * 1000 },
                error: "mocked:\(match.mockId)",
                requestBody: request.httpBody.flatMap { data in
                    AutoMobileNetwork.isTextContentType(request.value(forHTTPHeaderField: "Content-Type"))
                        ? AutoMobileNetwork.utf8String(from: data.prefix(AutoMobileNetwork.shared.maxBodyBytes))
                        : nil
                },
                responseBody: match.responseBody,
                contentType: match.contentType
            ))
            return
        }

        if AutoMobileSDK.shared.isEnabled,
           let url = request.url,
           let simulation = NetworkMockRuleStore.shared.activeErrorSimulation()
        {
            serveSimulatedError(simulation, url: url)
            return
        }
        #endif

        guard let mutableRequest = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutableRequest)

        // Use ephemeral config to avoid inheriting our own URLProtocol (infinite loop).
        // Ephemeral preserves standard HTTP semantics without persisting cookies/caches,
        // which is acceptable since we're replaying on behalf of the caller's session.
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = config.protocolClasses?.filter { $0 != AutoMobileURLProtocol.self }
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        urlSession = session
        dataTask = session.dataTask(with: mutableRequest as URLRequest)
        dataTask?.resume()
    }

    public override func stopLoading() {
        // Cancel a pending delayed fault and mark the protocol stopped so neither the
        // timer block (if not yet started) nor an already-running serveFault invokes the
        // client after teardown.
        faultLock.lock()
        stopped = true
        faultWorkItem?.cancel()
        faultWorkItem = nil
        faultLock.unlock()

        dataTask?.cancel()
        // Invalidate session to break the retain cycle (session -> delegate -> self)
        urlSession?.invalidateAndCancel()
        urlSession = nil
        dataTask = nil
    }

    #if DEBUG
    private func serveFault(_ fault: NetworkMockRuleStore.FaultDecision, url: URL) {
        // If the protocol was stopped (e.g. the delayed-fault timer began executing just
        // as stopLoading() ran), do not invoke the client on a torn-down protocol.
        faultLock.lock()
        let isStopped = stopped
        faultLock.unlock()
        if isStopped { return }

        let method = request.httpMethod ?? "GET"
        let error: URLError
        switch fault.errorType {
        case "dnsFailure": error = URLError(.cannotFindHost)
        case "connectionReset", "reset": error = URLError(.networkConnectionLost)
        case "timeout": error = URLError(.timedOut)
        default: error = URLError(.cannotConnectToHost)
        }

        if fault.action == .error || fault.action == .closeConnection {
            client?.urlProtocol(self, didFailWithError: error)
            AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
                url: url.absoluteString, method: method, error: "fault:\(fault.faultId):\(fault.action.rawValue)"
            ))
            return
        }

        let body = Data((fault.responseBody ?? "").utf8)
        let drop = max(0, fault.dropBytes ?? 0)
        let delivered = drop == 0 ? body : body.dropLast(min(drop, body.count))
        var headers = fault.responseHeaders
        if let contentType = fault.contentType {
            headers["Content-Type"] = contentType
        }
        let status = fault.statusCode ?? 200
        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
        )!  // swiftlint:disable:this force_unwrapping
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !delivered.isEmpty {
            client?.urlProtocol(self, didLoad: Data(delivered))
        }
        client?.urlProtocolDidFinishLoading(self)
        AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
            url: url.absoluteString, method: method, statusCode: status,
            responseHeaders: headers, responseBodySize: delivered.count,
            error: "fault:\(fault.faultId):\(fault.action.rawValue)",
            responseBody: String(decoding: delivered, as: UTF8.self),
            contentType: fault.contentType
        ))
    }

    private func capturedRequestBodyData(limit: Int?) -> Data? {
        guard let limit, limit > 0 else {
            return nil
        }

        if let body = request.httpBody {
            return Data(body.prefix(limit))
        }

        guard let stream = request.httpBodyStream else {
            return nil
        }

        stream.open()
        defer { stream.close() }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable, data.count < limit {
            let remaining = limit - data.count
            let read = stream.read(&buffer, maxLength: min(buffer.count, remaining))
            if read > 0 {
                data.append(buffer, count: read)
            } else {
                break
            }
        }
        return data.isEmpty ? nil : data
    }

    private func serveSimulatedError(_ simulation: NetworkMockRuleStore.ErrorSimulation, url: URL) {
        let method = request.httpMethod ?? "GET"
        let durationMs = startTime.map { Date().timeIntervalSince($0) * 1000 }
        let requestBodySize = request.httpBody?.count
        let requestBodyData: Data?
        if AutoMobileNetwork.isTextContentType(request.value(forHTTPHeaderField: "Content-Type")) {
            requestBodyData = capturedRequestBodyData(limit: AutoMobileNetwork.shared.requestBodyCaptureLimit)
        } else {
            requestBodyData = nil
        }
        let requestBody = requestBodyData.flatMap { AutoMobileNetwork.utf8String(from: $0) }

        if simulation.errorType == "http500" {
            // HTTPURLResponse(url:statusCode:...) only fails on a nil-ish URL; `url`
            // is a valid request URL and 500 is a valid status code.
            let response = HTTPURLResponse(
                url: url,
                statusCode: 500,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            )!  // swiftlint:disable:this force_unwrapping
            AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
                url: url.absoluteString,
                method: method,
                requestHeaders: request.allHTTPHeaderFields,
                requestBodySize: requestBodySize,
                statusCode: 500,
                durationMs: durationMs,
                error: "simulated:\(simulation.errorType)",
                requestBody: requestBody
            ))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }

        let code: URLError.Code
        switch simulation.errorType {
        case "timeout":
            code = .timedOut
        case "connectionRefused":
            code = .cannotConnectToHost
        case "dnsFailure":
            code = .cannotFindHost
        case "tlsFailure":
            code = .secureConnectionFailed
        default:
            code = .cannotConnectToHost
        }

        AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
            url: url.absoluteString,
            method: method,
            requestHeaders: request.allHTTPHeaderFields,
            requestBodySize: requestBodySize,
            durationMs: durationMs,
            error: "simulated:\(simulation.errorType)",
            requestBody: requestBody
        ))
        client?.urlProtocol(self, didFailWithError: URLError(code))
    }
    #endif
}

extension AutoMobileURLProtocol: URLSessionDataDelegate {
    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        receivedResponse = response
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        totalBytesReceived += data.count
        // Accumulate response data for body capture (up to configured limit)
        let maxBytes = AutoMobileNetwork.shared.maxBodyBytes
        if receivedData.count < maxBytes {
            receivedData.append(data.prefix(maxBytes - receivedData.count))
        }
        client?.urlProtocol(self, didLoad: data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let durationMs = startTime.map { Date().timeIntervalSince($0) * 1000 }

        if let error = error {
            AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
                url: request.url?.absoluteString ?? "",
                method: request.httpMethod ?? "GET",
                durationMs: durationMs,
                error: error.localizedDescription
            ))
            client?.urlProtocol(self, didFailWithError: error)
        } else {
            let httpResponse = receivedResponse as? HTTPURLResponse
            let contentType = httpResponse?.value(forHTTPHeaderField: "Content-Type")

            // Capture request body from original request
            let maxBytes = AutoMobileNetwork.shared.maxBodyBytes
            let requestBody: String? = request.httpBody.flatMap { data in
                AutoMobileNetwork.isTextContentType(request.value(forHTTPHeaderField: "Content-Type"))
                    ? AutoMobileNetwork.utf8String(from: data.prefix(maxBytes))
                    : nil
            }

            // Capture response body if text content type (already byte-truncated during streaming)
            let responseBody: String? = AutoMobileNetwork.isTextContentType(contentType) && !receivedData.isEmpty
                ? AutoMobileNetwork.utf8String(from: receivedData)
                : nil

            AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
                url: request.url?.absoluteString ?? "",
                method: request.httpMethod ?? "GET",
                requestHeaders: request.allHTTPHeaderFields,
                requestBodySize: request.httpBody?.count,
                statusCode: httpResponse?.statusCode,
                responseHeaders: httpResponse?.allHeaderFields as? [String: String],
                responseBodySize: totalBytesReceived,
                durationMs: durationMs,
                requestBody: requestBody,
                responseBody: responseBody,
                contentType: contentType
            ))

            client?.urlProtocolDidFinishLoading(self)
        }
        // Break retain cycle after completion
        urlSession?.finishTasksAndInvalidate()
        urlSession = nil
        dataTask = nil
    }
}
