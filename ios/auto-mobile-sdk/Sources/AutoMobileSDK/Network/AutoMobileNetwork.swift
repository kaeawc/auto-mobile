import Foundation

/// Network request/response tracking for URLSession.
/// iOS equivalent of Android's OkHttp interceptor.
public final class AutoMobileNetwork: @unchecked Sendable {
    public static let shared = AutoMobileNetwork()

    private let lock = NSLock()
    private var bundleId: String?
    private weak var buffer: SdkEventBuffer?
    private var _captureHeaders = false
    private var _captureBodies = false

    private init() {}

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
    public func setCaptureBodies(_ capture: Bool) {
        lock.lock()
        _captureBodies = capture
        lock.unlock()
    }

    /// Create a URLProtocol class that intercepts and records network requests.
    /// Register it with URLSessionConfiguration.protocolClasses.
    public func protocolClass() -> AnyClass {
        return AutoMobileURLProtocol.self
    }

    /// Record a network request/response manually.
    /// Use this when you can't use the URLProtocol approach.
    public func recordRequest(
        url: String,
        method: String,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil,
        statusCode: Int? = nil,
        responseHeaders: [String: String]? = nil,
        responseBodySize: Int? = nil,
        durationMs: Double? = nil,
        error: String? = nil
    ) {
        lock.lock()
        let captureHeaders = _captureHeaders
        let currentBuffer = buffer
        lock.unlock()

        let event = SdkNetworkRequestEvent(
            url: url,
            method: method,
            requestHeaders: captureHeaders ? requestHeaders : nil,
            requestBodySize: requestBodySize,
            statusCode: statusCode,
            responseHeaders: captureHeaders ? responseHeaders : nil,
            responseBodySize: responseBodySize,
            durationMs: durationMs,
            error: error
        )
        currentBuffer?.add(event)
    }

    /// Record a WebSocket frame event.
    public func recordWebSocketFrame(
        url: String,
        direction: WebSocketFrameDirection,
        frameType: WebSocketFrameType,
        payloadSize: Int? = nil
    ) {
        lock.lock()
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
        _captureHeaders = false
        _captureBodies = false
        lock.unlock()
    }
}

// MARK: - URLProtocol Implementation

/// A URLProtocol subclass that intercepts network requests for monitoring.
/// Register with: URLSessionConfiguration.default.protocolClasses = [AutoMobileURLProtocol.self]
public class AutoMobileURLProtocol: URLProtocol {
    private static let handledKey = "dev.jasonpearson.automobile.sdk.handled"
    private var startTime: Date?
    private var dataTask: URLSessionDataTask?

    public override class func canInit(with request: URLRequest) -> Bool {
        guard URLProtocol.property(forKey: handledKey, in: request) == nil else {
            return false
        }
        return true
    }

    public override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    public override func startLoading() {
        startTime = Date()

        guard let mutableRequest = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutableRequest)

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        dataTask = session.dataTask(with: mutableRequest as URLRequest)
        dataTask?.resume()
    }

    public override func stopLoading() {
        dataTask?.cancel()
    }
}

extension AutoMobileURLProtocol: URLSessionDataDelegate {
    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let httpResponse = response as? HTTPURLResponse
        let durationMs = startTime.map { Date().timeIntervalSince($0) * 1000 }

        AutoMobileNetwork.shared.recordRequest(
            url: request.url?.absoluteString ?? "",
            method: request.httpMethod ?? "GET",
            requestHeaders: request.allHTTPHeaderFields,
            requestBodySize: request.httpBody?.count,
            statusCode: httpResponse?.statusCode,
            responseHeaders: httpResponse?.allHeaderFields as? [String: String],
            responseBodySize: Int(response.expectedContentLength),
            durationMs: durationMs
        )

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        client?.urlProtocol(self, didLoad: data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            let durationMs = startTime.map { Date().timeIntervalSince($0) * 1000 }
            AutoMobileNetwork.shared.recordRequest(
                url: request.url?.absoluteString ?? "",
                method: request.httpMethod ?? "GET",
                durationMs: durationMs,
                error: error.localizedDescription
            )
            client?.urlProtocol(self, didFailWithError: error)
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}
