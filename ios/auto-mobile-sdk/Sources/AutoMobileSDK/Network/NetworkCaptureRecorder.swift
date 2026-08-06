import Foundation
import Network

/// The direction of a captured transport event.
public enum NetworkCaptureDirection: String, Codable, Sendable {
    case request
    case response
    case sent
    case received
}

/// Thread-safe lifecycle recorder for transports that cannot use `URLProtocol`.
///
/// Adapters call the lifecycle methods from their delegate or connection queues.
/// The recorder emits at most one terminal `NetworkRequestRecord` per request.
public final class NetworkCaptureRecorder: @unchecked Sendable {
    public typealias Emit = @Sendable (NetworkRequestRecord) -> Void
    public typealias IDGenerator = @Sendable () -> String

    private struct InFlightRequest {
        let requestId: String
        let url: String
        let method: String
        let connectionId: String?
        let protocolName: String
        var metadata: [String: String] = [:]
        var requestHeaders: [String: String]?
        var requestBodySize: Int?
        var requestBody: String?
        var responseHeaders: [String: String]?
        var responseBodySize: Int = 0
        var responseBody: String?
        var terminal = false
        let sampled: Bool
    }

    private let lock = NSLock()
    private let emit: Emit
    private let emissionLock = NSLock()
    private let idGenerator: IDGenerator
    private let isEnabled: @Sendable () -> Bool
    private let isBodyCaptureEnabled: @Sendable () -> Bool
    private let samplingRate: Double
    private let sampler: @Sendable () -> Double
    private let headerRedactor: @Sendable ([String: String]) -> [String: String]
    private var requests: [String: InFlightRequest] = [:]
    private var nextSequenceNumber: UInt64 = 0
    private let maxBodyBytes: Int

    public init(
        emit: @escaping Emit,
        maxBodyBytes: Int = 32 * 1024,
        idGenerator: @escaping IDGenerator = { UUID().uuidString },
        isEnabled: @escaping @Sendable () -> Bool = { true },
        isBodyCaptureEnabled: @escaping @Sendable () -> Bool = { true },
        samplingRate: Double = 1,
        sampler: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
        headerRedactor: @escaping @Sendable ([String: String]) -> [String: String] = {
            NetworkCaptureRecorder.redactHeaders($0)
        }
    ) {
        self.emit = emit
        self.maxBodyBytes = max(0, maxBodyBytes)
        self.idGenerator = idGenerator
        self.isEnabled = isEnabled
        self.isBodyCaptureEnabled = isBodyCaptureEnabled
        self.samplingRate = min(max(samplingRate, 0), 1)
        self.sampler = sampler
        self.headerRedactor = headerRedactor
    }

    /// Starts a request lifecycle and returns its stable request identifier.
    @discardableResult
    public func beginRequest(
        url: String,
        method: String = "GET",
        connectionId: String? = nil,
        protocolName: String = "http",
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil,
        requestBody: String? = nil
    ) -> String {
        let requestId = nextRequestId()
        let sampled = isEnabled() && sampler() < samplingRate
        let request = InFlightRequest(
            requestId: requestId,
            url: url,
            method: method,
            connectionId: connectionId,
            protocolName: protocolName,
            requestHeaders: requestHeaders.map(headerRedactor),
            requestBodySize: requestBodySize,
            requestBody: truncate(requestBody),
            responseHeaders: nil,
            sampled: sampled
        )
        lock.lock()
        requests[requestId] = request
        lock.unlock()
        return requestId
    }

    public func recordRequestHeaders(
        requestId: String,
        headers: [String: String]
    ) {
        update(requestId) { request in
            request.requestHeaders = headerRedactor(headers)
        }
    }

    public func recordResponseHeaders(
        requestId: String,
        headers: [String: String]
    ) {
        update(requestId) { request in
            request.responseHeaders = headerRedactor(headers)
        }
    }

    public func recordMetadata(requestId: String, key: String, value: String) {
        update(requestId) { request in
            request.metadata[key] = value
        }
    }

    public func recordRequestBodyChunk(
        requestId: String,
        bytes: Int,
        text: String? = nil
    ) {
        update(requestId) { request in
            request.requestBodySize = (request.requestBodySize ?? 0) + max(0, bytes)
            request.requestBody = append(request.requestBody, text)
        }
    }

    public func recordResponseBodyChunk(
        requestId: String,
        bytes: Int,
        text: String? = nil
    ) {
        update(requestId) { request in
            request.responseBodySize += max(0, bytes)
            request.responseBody = append(request.responseBody, text)
        }
    }

    public func recordCompletion(
        requestId: String,
        statusCode: Int? = nil,
        responseHeaders: [String: String]? = nil,
        responseBodySize: Int? = nil
    ) {
        update(requestId) { request in
            request.responseHeaders = responseHeaders.map(headerRedactor) ?? request.responseHeaders
            if let responseBodySize {
                request.responseBodySize = responseBodySize
            }
        }
        finish(requestId) { request in
            return NetworkRequestRecord(
                url: request.url,
                method: request.method,
                requestId: request.requestId,
                connectionId: request.connectionId,
                direction: .response,
                protocolName: request.protocolName,
                metadata: request.metadata.isEmpty ? nil : request.metadata,
                requestHeaders: request.requestHeaders,
                requestBodySize: request.requestBodySize,
                statusCode: statusCode,
                responseHeaders: request.responseHeaders,
                responseBodySize: request.responseBodySize == 0 ? nil : request.responseBodySize,
                requestBody: request.requestBody,
                responseBody: request.responseBody
            )
        }
    }

    public func recordFailure(requestId: String, error: Error) {
        recordFailure(requestId: requestId, error: error.localizedDescription)
    }

    public func recordFailure(requestId: String, error: String) {
        finish(requestId) { request in
            NetworkRequestRecord(
                url: request.url,
                method: request.method,
                requestId: request.requestId,
                connectionId: request.connectionId,
                direction: .response,
                protocolName: request.protocolName,
                metadata: request.metadata.isEmpty ? nil : request.metadata,
                requestHeaders: request.requestHeaders,
                requestBodySize: request.requestBodySize,
                responseHeaders: request.responseHeaders,
                responseBodySize: request.responseBodySize == 0 ? nil : request.responseBodySize,
                error: error,
                requestBody: request.requestBody,
                responseBody: request.responseBody
            )
        }
    }

    /// Records one WebSocket message or control frame as a transport event.
    public func recordWebSocketFrame(
        url: String,
        connectionId: String?,
        direction: NetworkCaptureDirection,
        frameType: WebSocketFrameType,
        payloadSize: Int?
    ) {
        guard isEnabled(), sampler() < samplingRate else {
            return
        }
        emitRecord(NetworkRequestRecord(
            url: url,
            method: frameType.rawValue,
            requestId: nextRequestId(),
            connectionId: connectionId,
            direction: direction,
            protocolName: "websocket",
            requestBodySize: direction == .sent ? payloadSize : nil,
            responseBodySize: direction == .received ? payloadSize : nil
        ))
    }

    private func nextRequestId() -> String {
        idGenerator()
    }

    private func update(_ requestId: String, _ body: (inout InFlightRequest) -> Void) {
        lock.lock()
        guard var request = requests[requestId], !request.terminal else {
            lock.unlock()
            return
        }
        body(&request)
        requests[requestId] = request
        lock.unlock()
    }

    private func finish(
        _ requestId: String,
        _ makeRecord: (InFlightRequest) -> NetworkRequestRecord
    ) {
        lock.lock()
        guard var request = requests.removeValue(forKey: requestId), !request.terminal else {
            lock.unlock()
            return
        }
        request.terminal = true
        lock.unlock()
        guard request.sampled else { return }
        emitRecord(makeRecord(request))
    }

    private func emitRecord(_ record: NetworkRequestRecord) {
        emissionLock.lock()
        nextSequenceNumber += 1
        var sequencedRecord = record
        sequencedRecord.sequenceNumber = nextSequenceNumber
        emit(sequencedRecord)
        emissionLock.unlock()
    }

    private func truncate(_ value: String?) -> String? {
        guard isBodyCaptureEnabled(), let value, maxBodyBytes > 0 else { return nil }
        return String(decoding: value.utf8.prefix(maxBodyBytes), as: UTF8.self)
    }

    private func append(_ current: String?, _ next: String?) -> String? {
        guard isBodyCaptureEnabled(), let next, maxBodyBytes > 0 else { return current }
        return truncate((current ?? "") + next)
    }

    /// Redacts headers that commonly carry credentials or user identity.
    public static func redactHeaders(_ headers: [String: String]) -> [String: String] {
        let sensitiveNames: Set<String> = [
            "authorization", "proxy-authorization", "cookie", "set-cookie",
            "x-api-key", "x-auth-token", "x-csrf-token",
        ]
        var redacted = headers
        for key in headers.keys where sensitiveNames.contains(key.lowercased()) {
            redacted[key] = "<redacted>"
        }
        return redacted
    }
}

/// Adapter for URLSession delegates that already receive lifecycle callbacks.
public final class URLSessionNetworkCaptureAdapter: @unchecked Sendable {
    private let recorder: NetworkCaptureRecorder

    public init(recorder: NetworkCaptureRecorder) {
        self.recorder = recorder
    }

    @discardableResult
    public func begin(
        url: String,
        method: String = "GET",
        connectionId: String? = nil,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil
    ) -> String {
        recorder.beginRequest(
            url: url,
            method: method,
            connectionId: connectionId,
            requestHeaders: requestHeaders,
            requestBodySize: requestBodySize
        )
    }

    @discardableResult
    public func begin(
        task: URLSessionTask,
        connectionId: String? = nil
    ) -> String {
        let request = task.originalRequest ?? task.currentRequest
        return begin(
            url: request?.url?.absoluteString ?? "",
            method: request?.httpMethod ?? "GET",
            connectionId: connectionId,
            requestHeaders: request?.allHTTPHeaderFields,
            requestBodySize: request?.httpBody?.count
        )
    }

    public func didReceiveResponseHeaders(requestId: String, headers: [String: String]) {
        recorder.recordResponseHeaders(requestId: requestId, headers: headers)
    }

    public func didReceiveBody(requestId: String, bytes: Int, text: String? = nil) {
        recorder.recordResponseBodyChunk(requestId: requestId, bytes: bytes, text: text)
    }

    public func didReceiveMetrics(requestId: String, durationMs: Double) {
        recorder.recordMetadata(requestId: requestId, key: "duration_ms", value: String(durationMs))
    }

    public func didRedirect(requestId: String, url: String) {
        recorder.recordMetadata(requestId: requestId, key: "redirect_url", value: url)
    }

    public func didAuthenticate(requestId: String, method: String) {
        recorder.recordMetadata(requestId: requestId, key: "authentication_method", value: method)
    }

    public func didComplete(requestId: String, statusCode: Int? = nil) {
        recorder.recordCompletion(requestId: requestId, statusCode: statusCode)
    }

    public func didFail(requestId: String, error: Error) {
        recorder.recordFailure(requestId: requestId, error: error)
    }
}

/// Adapter for URLSessionWebSocketTask message and close callbacks.
public final class WebSocketNetworkCaptureAdapter: @unchecked Sendable {
    private let recorder: NetworkCaptureRecorder

    public init(recorder: NetworkCaptureRecorder) {
        self.recorder = recorder
    }

    public func recordFrame(
        url: String,
        connectionId: String?,
        direction: NetworkCaptureDirection,
        frameType: WebSocketFrameType,
        payloadSize: Int?
    ) {
        recorder.recordWebSocketFrame(
            url: url,
            connectionId: connectionId,
            direction: direction,
            frameType: frameType,
            payloadSize: payloadSize
        )
    }
}

/// Adapter for Network.framework connection state and byte callbacks.
public final class NWConnectionNetworkCaptureAdapter: @unchecked Sendable {
    private let recorder: NetworkCaptureRecorder

    public init(recorder: NetworkCaptureRecorder) {
        self.recorder = recorder
    }

    @discardableResult
    public func begin(
        endpoint: String,
        connectionId: String
    ) -> String {
        recorder.beginRequest(
            url: endpoint,
            method: "CONNECTION",
            connectionId: connectionId,
            protocolName: "nwconnection"
        )
    }

    public func didSend(requestId: String, bytes: Int) {
        recorder.recordRequestBodyChunk(requestId: requestId, bytes: bytes)
    }

    public func didUpdateState(requestId: String, state: String) {
        recorder.recordMetadata(requestId: requestId, key: "connection_state", value: state)
    }

    public func didReceive(requestId: String, bytes: Int, text: String? = nil) {
        recorder.recordResponseBodyChunk(requestId: requestId, bytes: bytes, text: text)
    }

    public func didComplete(requestId: String) {
        recorder.recordCompletion(requestId: requestId)
    }

    public func didFail(requestId: String, error: NWError) {
        recorder.recordFailure(requestId: requestId, error: String(describing: error))
    }

    public func didCancel(requestId: String) {
        recorder.recordFailure(requestId: requestId, error: "cancelled")
    }
}
