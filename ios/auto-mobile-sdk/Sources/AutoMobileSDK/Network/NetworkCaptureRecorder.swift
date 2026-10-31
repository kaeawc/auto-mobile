import Foundation
import Network
import os

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
public final class NetworkCaptureRecorder: Sendable {
    public typealias Emit = @Sendable (NetworkRequestRecord) -> Void
    public typealias IDGenerator = @Sendable () -> String

    private struct InFlightRequest: Sendable {
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
        var responseBodySize = 0
        var responseBody: String?
        var terminal = false
        let sampled: Bool
    }

    private let lock = OSAllocatedUnfairLock<[String: InFlightRequest]>(initialState: [:])
    private let emit: Emit
    private let sequenceAllocator: NetworkSequenceAllocator
    private let idGenerator: IDGenerator
    private let isEnabled: @Sendable () -> Bool
    private let isBodyCaptureEnabled: @Sendable () -> Bool
    private let samplingRate: Double
    private let sampler: @Sendable () -> Double
    private let headerRedactor: @Sendable ([String: String]) -> [String: String]
    private let maxBodyBytes: Int

    public convenience init(
        emit: @escaping Emit,
        maxBodyBytes: Int = 32 * 1024,
        idGenerator: @escaping IDGenerator = { UUID().uuidString },
        isEnabled: @escaping @Sendable () -> Bool = { true },
        isBodyCaptureEnabled: @escaping @Sendable () -> Bool = { true },
        samplingRate: Double = 1,
        sampler: @escaping @Sendable () -> Double = { Double.random(in: 0 ..< 1) },
        headerRedactor: @escaping @Sendable ([String: String]) -> [String: String] = {
            NetworkCaptureRecorder.redactHeaders($0)
        }
    ) {
        self.init(
            emit: emit,
            maxBodyBytes: maxBodyBytes,
            idGenerator: idGenerator,
            isEnabled: isEnabled,
            isBodyCaptureEnabled: isBodyCaptureEnabled,
            samplingRate: samplingRate,
            sampler: sampler,
            headerRedactor: headerRedactor,
            sequenceAllocator: NetworkSequenceAllocator()
        )
    }

    init(
        emit: @escaping Emit,
        maxBodyBytes: Int = 32 * 1024,
        idGenerator: @escaping IDGenerator = { UUID().uuidString },
        isEnabled: @escaping @Sendable () -> Bool = { true },
        isBodyCaptureEnabled: @escaping @Sendable () -> Bool = { true },
        samplingRate: Double = 1,
        sampler: @escaping @Sendable () -> Double = { Double.random(in: 0 ..< 1) },
        headerRedactor: @escaping @Sendable ([String: String]) -> [String: String] = {
            NetworkCaptureRecorder.redactHeaders($0)
        },
        sequenceAllocator: NetworkSequenceAllocator
    ) {
        self.emit = emit
        self.sequenceAllocator = sequenceAllocator
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
    )
        -> String
    {
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
        lock.withLock { requests in
            requests[requestId] = request
        }
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
        complete(requestId, mutate: { request in
            request.responseHeaders = responseHeaders.map(headerRedactor) ?? request.responseHeaders
            if let responseBodySize {
                request.responseBodySize = responseBodySize
            }
        }, { request in
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
                statusCode: statusCode,
                responseHeaders: request.responseHeaders,
                responseBodySize: request.responseBodySize == 0 ? nil : request.responseBodySize,
                requestBody: request.requestBody,
                responseBody: request.responseBody
            )
        })
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

    private func update(_ requestId: String, _ body: @Sendable (inout InFlightRequest) -> Void) {
        lock.withLock { requests in
            guard var request = requests[requestId], !request.terminal else {
                return
            }
            body(&request)
            requests[requestId] = request
        }
    }

    private func finish(
        _ requestId: String,
        _ makeRecord: @Sendable (InFlightRequest) -> NetworkRequestRecord
    ) {
        complete(requestId, mutate: { _ in }, makeRecord)
    }

    /// Applies a final `mutate` and snapshots the record in ONE critical section, so a
    /// concurrent chunk cannot land between a completion mutation and the record snapshot
    /// (torn `responseBodySize`/`responseBody`). `emitRecord` runs outside the lock.
    private func complete(
        _ requestId: String,
        mutate: @Sendable (inout InFlightRequest) -> Void,
        _ makeRecord: @Sendable (InFlightRequest) -> NetworkRequestRecord
    ) {
        let record = lock.withLock { requests -> NetworkRequestRecord? in
            guard var request = requests.removeValue(forKey: requestId), !request.terminal else {
                return nil
            }
            mutate(&request)
            request.terminal = true
            return request.sampled ? makeRecord(request) : nil
        }
        if let record {
            emitRecord(record)
        }
    }

    private func emitRecord(_ record: NetworkRequestRecord) {
        // Assign the sequence number from the shared allocator before calling `emit`.
        // `emit` runs outside any lock so re-entrant callbacks cannot self-deadlock
        // or invert lock order.
        //
        // `emit` is called SYNCHRONOUSLY (not via a recorder-owned queue): a completion is
        // therefore fully delivered to the sink before `recordCompletion` returns — nothing
        // is left queued to be dropped if `AutoMobileSDK.shutdown()` then clears the buffer —
        // and backpressure/bounding stays the sink's responsibility (`SdkEventBuffer`'s
        // `maxPendingEvents`) rather than a second, unbounded recorder-level queue. The one
        // cost is that two genuinely-concurrent emits may reach the sink out of order; every
        // record carries `sequenceNumber`, which exists precisely so a consumer can restore
        // the total order. Preserving strict delivery order here would require either holding
        // the lock across `emit` (the deadlock above) or an unbounded in-recorder queue.
        var sequencedRecord = record
        sequencedRecord.sequenceNumber = sequenceAllocator.next()
        emit(sequencedRecord)
    }

    private func truncate(_ value: String?) -> String? {
        guard isBodyCaptureEnabled(), let value, maxBodyBytes > 0 else { return nil }
        // A byte limit can split a scalar; preserve replacement decoding for that suffix.
        return String(decoding: value.utf8.prefix(maxBodyBytes), as: Unicode.UTF8.self)
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
public final class URLSessionNetworkCaptureAdapter: Sendable {
    private let recorder: NetworkCaptureRecorder

    public init(recorder: NetworkCaptureRecorder) {
        self.recorder = recorder
    }

    #if DEBUG
        public func evaluateFault(for task: URLSessionTask, sessionId: String? = nil) -> NetworkMockRuleStore
            .FaultDecision?
        {
            let request = task.originalRequest ?? task.currentRequest
            guard let url = request?.url, AutoMobileSDK.shared.isEnabled else { return nil }
            return NetworkMockRuleStore.shared.evaluate(.init(
                transport: .urlSession, host: url.host, port: url.port, scheme: url.scheme,
                path: url.path, method: request?.httpMethod ?? "GET",
                headers: request?.allHTTPHeaderFields ?? [:],
                origin: request?.value(forHTTPHeaderField: "Origin"),
                connectionId: nil, sessionId: sessionId
            ))
        }
    #endif

    @discardableResult
    public func begin(
        url: String,
        method: String = "GET",
        connectionId: String? = nil,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil
    )
        -> String
    {
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
    )
        -> String
    {
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
///
/// ``send(_:on:connectionId:sessionId:completionHandler:)`` and
/// ``receive(on:connectionId:sessionId:completionHandler:)`` also enforce matched fault rules
/// (#5163): `latency` delays the frame, and `error` / `closeConnection` closes the task (a `reset`
/// error type resets it) and completes with `URLError(.networkConnectionLost)`. Other actions are
/// recorded as unsupported and not applied.
public final class WebSocketNetworkCaptureAdapter: Sendable {
    private let recorder: NetworkCaptureRecorder

    #if DEBUG
        private let faultStore: NetworkMockRuleStore
        private let faultScheduler: any FaultScheduling
    #endif

    public init(recorder: NetworkCaptureRecorder) {
        self.recorder = recorder
        #if DEBUG
            faultStore = NetworkMockRuleStore.shared
            faultScheduler = RealFaultScheduler()
        #endif
    }

    #if DEBUG
        init(recorder: NetworkCaptureRecorder, faultStore: NetworkMockRuleStore, faultScheduler: any FaultScheduling) {
            self.recorder = recorder
            self.faultStore = faultStore
            self.faultScheduler = faultScheduler
        }
    #endif

    private func schedule(_ delayMs: Int, _ work: @escaping @Sendable () -> Void) {
        #if DEBUG
            faultScheduler.schedule(delayMs: delayMs, work: work)
        #else
            work()
        #endif
    }

    /// Records a delay or unsupported decision: as metadata on `requestId`, or as its own completed
    /// record when there is none. A fail decision is recorded by ``recordAppliedFailure``.
    private func recordDecision(
        _ outcome: AdapterFaultOutcome,
        requestId: String?,
        url: String,
        method: String,
        connectionId: String?,
        protocolName: String
    ) {
        if outcome == .proceed { return }
        if case .fail = outcome, requestId == nil { return }
        let id = requestId ?? recorder.beginRequest(
            url: url, method: method, connectionId: connectionId, protocolName: protocolName
        )
        for (key, value) in outcome.metadata.sorted(by: { $0.key < $1.key }) {
            recorder.recordMetadata(requestId: id, key: key, value: value)
        }
        if requestId == nil {
            recorder.recordCompletion(requestId: id)
        }
    }

    /// Records an applied fail rule as a failed exchange in the URLProtocol's `fault:<id>:<action>` form.
    private func recordAppliedFailure(
        _ outcome: AdapterFaultOutcome,
        requestId: String?,
        url: String,
        method: String,
        connectionId: String?,
        protocolName: String
    ) {
        let id = requestId ?? recorder.beginRequest(
            url: url, method: method, connectionId: connectionId, protocolName: protocolName
        )
        if requestId == nil {
            for (key, value) in outcome.metadata.sorted(by: { $0.key < $1.key }) {
                recorder.recordMetadata(requestId: id, key: key, value: value)
            }
        }
        recorder.recordFailure(requestId: id, error: outcome.recordedError ?? "fault")
    }

    /// Sends `message` on `task`, applying a matched fault rule first, and records the sent frame.
    public func send(
        _ message: URLSessionWebSocketTask.Message,
        on task: URLSessionWebSocketTask,
        connectionId: String?,
        sessionId: String? = nil,
        completionHandler: @escaping @Sendable (Error?) -> Void
    ) {
        send(
            WebSocketPayload(message), operations: WebSocketOperations(task: task),
            connectionId: connectionId, sessionId: sessionId, completionHandler: completionHandler
        )
    }

    /// Receives the next message from `task`, applying a matched fault rule before delivering it,
    /// and records the received frame.
    public func receive(
        on task: URLSessionWebSocketTask,
        connectionId: String?,
        sessionId: String? = nil,
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    ) {
        receive(
            operations: WebSocketOperations(task: task), connectionId: connectionId, sessionId: sessionId
        ) { result in
            completionHandler(result.map(\.message))
        }
    }

    func send(
        _ payload: WebSocketPayload,
        operations: WebSocketOperations,
        connectionId: String?,
        sessionId: String?,
        completionHandler: @escaping @Sendable (Error?) -> Void
    ) {
        let outcome = faultOutcome(
            url: operations.url, connectionId: connectionId, direction: .sent, sessionId: sessionId
        )
        apply(outcome, operations: operations, connectionId: connectionId, method: "SEND", perform: { [self] in
            operations.send(payload) { error in
                if error == nil {
                    self.recordFrame(
                        url: operations.url, connectionId: connectionId, direction: .sent,
                        frameType: payload.frameType, payloadSize: payload.payloadSize
                    )
                }
                completionHandler(error)
            }
        }, fail: { completionHandler($0) })
    }

    func receive(
        operations: WebSocketOperations,
        connectionId: String?,
        sessionId: String?,
        completionHandler: @escaping @Sendable (Result<WebSocketPayload, Error>) -> Void
    ) {
        operations.receive { [self] result in
            guard case let .success(payload) = result else {
                completionHandler(result)
                return
            }
            let outcome = faultOutcome(
                url: operations.url, connectionId: connectionId, direction: .received, sessionId: sessionId
            )
            apply(outcome, operations: operations, connectionId: connectionId, method: "RECEIVE", perform: {
                self.recordFrame(
                    url: operations.url, connectionId: connectionId, direction: .received,
                    frameType: payload.frameType, payloadSize: payload.payloadSize
                )
                completionHandler(.success(payload))
            }, fail: { completionHandler(.failure($0)) })
        }
    }

    private func apply(
        _ outcome: AdapterFaultOutcome,
        operations: WebSocketOperations,
        connectionId: String?,
        method: String,
        perform: @escaping @Sendable () -> Void,
        fail: @escaping @Sendable (Error) -> Void
    ) {
        recordDecision(
            outcome, requestId: nil, url: operations.url, method: method,
            connectionId: connectionId, protocolName: "websocket"
        )
        switch outcome {
        case .proceed, .unsupported:
            perform()
        case let .delay(_, delayMs):
            schedule(delayMs, perform)
        case let .fail(_, _, errorType, delayMs):
            let failNow: @Sendable () -> Void = { [self] in
                let reset = errorType == "reset" || errorType == "connectionReset"
                operations.close(reset, outcome.recordedError ?? "fault")
                recordAppliedFailure(
                    outcome, requestId: nil, url: operations.url, method: method,
                    connectionId: connectionId, protocolName: "websocket"
                )
                fail(URLError(.networkConnectionLost))
            }
            if delayMs > 0 {
                schedule(delayMs, failNow)
            } else {
                failNow()
            }
        }
    }

    private func faultOutcome(
        url: String,
        connectionId: String?,
        direction: NetworkCaptureDirection,
        sessionId: String?
    )
        -> AdapterFaultOutcome
    {
        #if DEBUG
            guard AutoMobileSDK.shared.isEnabled, let parsed = URL(string: url) else { return .proceed }
            return AdapterFaultOutcome(faultStore.evaluate(.init(
                transport: .webSocket, host: parsed.host, port: parsed.port, scheme: parsed.scheme,
                path: parsed.path, method: direction == .sent ? "SEND" : "RECEIVE",
                headers: [:], origin: nil, connectionId: connectionId, sessionId: sessionId
            )))
        #else
            return .proceed
        #endif
    }

    #if DEBUG
        public func evaluateFault(
            url: String,
            connectionId: String?,
            direction: NetworkCaptureDirection,
            sessionId: String? = nil
        )
            -> NetworkMockRuleStore.FaultDecision?
        {
            guard AutoMobileSDK.shared.isEnabled, let parsed = URL(string: url) else { return nil }
            return NetworkMockRuleStore.shared.evaluate(.init(
                transport: .webSocket, host: parsed.host, port: parsed.port, scheme: parsed.scheme,
                path: parsed.path, method: direction == .sent ? "SEND" : "RECEIVE",
                headers: [:], origin: nil, connectionId: connectionId, sessionId: sessionId
            ))
        }
    #endif

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
///
/// ``start(_:queue:endpoint:connectionId:requestId:sessionId:onFault:)`` also enforces matched
/// fault rules (#5163): `latency` delays the start, and `error` / `closeConnection` never starts
/// the connection, cancels it and reports `NWError.posix` to `onFault`. Other actions are recorded
/// as unsupported and not applied.
public final class NWConnectionNetworkCaptureAdapter: Sendable {
    private let recorder: NetworkCaptureRecorder

    #if DEBUG
        private let faultStore: NetworkMockRuleStore
        private let faultScheduler: any FaultScheduling
    #endif

    public init(recorder: NetworkCaptureRecorder) {
        self.recorder = recorder
        #if DEBUG
            faultStore = NetworkMockRuleStore.shared
            faultScheduler = RealFaultScheduler()
        #endif
    }

    #if DEBUG
        init(recorder: NetworkCaptureRecorder, faultStore: NetworkMockRuleStore, faultScheduler: any FaultScheduling) {
            self.recorder = recorder
            self.faultStore = faultStore
            self.faultScheduler = faultScheduler
        }
    #endif

    private func schedule(_ delayMs: Int, _ work: @escaping @Sendable () -> Void) {
        #if DEBUG
            faultScheduler.schedule(delayMs: delayMs, work: work)
        #else
            work()
        #endif
    }

    /// Records a delay or unsupported decision: as metadata on `requestId`, or as its own completed
    /// record when there is none. A fail decision is recorded by ``recordAppliedFailure``.
    private func recordDecision(
        _ outcome: AdapterFaultOutcome,
        requestId: String?,
        url: String,
        method: String,
        connectionId: String?,
        protocolName: String
    ) {
        if outcome == .proceed { return }
        if case .fail = outcome, requestId == nil { return }
        let id = requestId ?? recorder.beginRequest(
            url: url, method: method, connectionId: connectionId, protocolName: protocolName
        )
        for (key, value) in outcome.metadata.sorted(by: { $0.key < $1.key }) {
            recorder.recordMetadata(requestId: id, key: key, value: value)
        }
        if requestId == nil {
            recorder.recordCompletion(requestId: id)
        }
    }

    /// Records an applied fail rule as a failed exchange in the URLProtocol's `fault:<id>:<action>` form.
    private func recordAppliedFailure(
        _ outcome: AdapterFaultOutcome,
        requestId: String?,
        url: String,
        method: String,
        connectionId: String?,
        protocolName: String
    ) {
        let id = requestId ?? recorder.beginRequest(
            url: url, method: method, connectionId: connectionId, protocolName: protocolName
        )
        if requestId == nil {
            for (key, value) in outcome.metadata.sorted(by: { $0.key < $1.key }) {
                recorder.recordMetadata(requestId: id, key: key, value: value)
            }
        }
        recorder.recordFailure(requestId: id, error: outcome.recordedError ?? "fault")
    }

    /// Starts `connection` on `queue`, applying a matched fault rule first. Pass the `requestId`
    /// from ``begin(endpoint:connectionId:)`` so the decision is recorded on that request.
    public func start(
        _ connection: NWConnection,
        queue: DispatchQueue,
        endpoint: String,
        connectionId: String,
        requestId: String? = nil,
        sessionId: String? = nil,
        onFault: @escaping @Sendable (NWError) -> Void
    ) {
        start(
            operations: ConnectionOperations(connection: connection, queue: queue), endpoint: endpoint,
            connectionId: connectionId, requestId: requestId, sessionId: sessionId, onFault: onFault
        )
    }

    func start(
        operations: ConnectionOperations,
        endpoint: String,
        connectionId: String,
        requestId: String?,
        sessionId: String?,
        onFault: @escaping @Sendable (NWError) -> Void
    ) {
        let outcome = faultOutcome(endpoint: endpoint, connectionId: connectionId, sessionId: sessionId)
        recordDecision(
            outcome, requestId: requestId, url: endpoint, method: "CONNECTION",
            connectionId: connectionId, protocolName: "nwconnection"
        )
        switch outcome {
        case .proceed, .unsupported:
            operations.start()
        case let .delay(_, delayMs):
            schedule(delayMs, operations.start)
        case let .fail(_, _, errorType, delayMs):
            let failNow: @Sendable () -> Void = { [self] in
                operations.cancel()
                recordAppliedFailure(
                    outcome, requestId: requestId, url: endpoint, method: "CONNECTION",
                    connectionId: connectionId, protocolName: "nwconnection"
                )
                onFault(.posix(AdapterFaultOutcome.posixCode(for: errorType)))
            }
            if delayMs > 0 {
                schedule(delayMs, failNow)
            } else {
                failNow()
            }
        }
    }

    private func faultOutcome(endpoint: String, connectionId: String, sessionId: String?) -> AdapterFaultOutcome {
        #if DEBUG
            guard AutoMobileSDK.shared.isEnabled, let parsed = URL(string: endpoint) else { return .proceed }
            return AdapterFaultOutcome(faultStore.evaluate(.init(
                transport: .nwConnection, host: parsed.host, port: parsed.port, scheme: parsed.scheme,
                path: parsed.path, method: "CONNECTION", headers: [:], origin: nil,
                connectionId: connectionId, sessionId: sessionId
            )))
        #else
            return .proceed
        #endif
    }

    #if DEBUG
        public func evaluateFault(
            endpoint: String,
            connectionId: String,
            sessionId: String? = nil
        )
            -> NetworkMockRuleStore.FaultDecision?
        {
            guard AutoMobileSDK.shared.isEnabled, let parsed = URL(string: endpoint) else { return nil }
            return NetworkMockRuleStore.shared.evaluate(.init(
                transport: .nwConnection, host: parsed.host, port: parsed.port, scheme: parsed.scheme,
                path: parsed.path, method: "CONNECTION", headers: [:], origin: nil,
                connectionId: connectionId, sessionId: sessionId
            ))
        }
    #endif

    @discardableResult
    public func begin(
        endpoint: String,
        connectionId: String
    )
        -> String
    {
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
