// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import AutoMobileSDK
import os
import XCTest

private final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    var events: [any SdkEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func collect(_ events: [any SdkEvent]) { lock.lock(); _events = events; lock.unlock() }
}

#if DEBUG
    /// Flushes and snapshots network events synchronously from URLProtocol terminal callbacks.
    private final class EventObservingURLProtocolClient: NSObject, URLProtocolClient {
        private let buffer: SdkEventBuffer
        private let collector: EventCollector
        private(set) var eventsAtTerminalCallback: [any SdkEvent] = []

        init(buffer: SdkEventBuffer, collector: EventCollector) {
            self.buffer = buffer
            self.collector = collector
        }

        private func captureEvents() {
            buffer.flush()
            eventsAtTerminalCallback = collector.events
        }

        func urlProtocol(_: URLProtocol, wasRedirectedTo _: URLRequest, redirectResponse _: URLResponse) {}
        func urlProtocol(_: URLProtocol, cachedResponseIsValid _: CachedURLResponse) {}
        func urlProtocol(_: URLProtocol, didReceive _: URLResponse, cacheStoragePolicy _: URLCache.StoragePolicy) {}
        func urlProtocol(_: URLProtocol, didLoad _: Data) {}
        func urlProtocolDidFinishLoading(_: URLProtocol) { captureEvents() }
        func urlProtocol(_: URLProtocol, didFailWithError _: Error) { captureEvents() }
        func urlProtocol(_: URLProtocol, didReceive _: URLAuthenticationChallenge) {}
        func urlProtocol(_: URLProtocol, didCancel _: URLAuthenticationChallenge) {}
    }
#endif

private final class NetworkRecordCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _records: [NetworkRequestRecord] = []

    var records: [NetworkRequestRecord] {
        lock.lock()
        defer { lock.unlock() }
        return _records
    }

    func append(_ record: NetworkRequestRecord) {
        lock.lock()
        _records.append(record)
        lock.unlock()
    }
}

final class AutoMobileNetworkTests: XCTestCase {
    func testStopBeforeTaskStorageRejectsSuspendedTask() throws {
        let request = try URLRequest(url: XCTUnwrap(URL(string: "https://example.invalid/stopped")))
        let client = RecordingURLProtocolClient()
        let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)
        proto.stopLoading()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: request)
        XCTAssertFalse(proto.storeTaskIfRunning(task, session: session))
        XCTAssertEqual(task.state, .suspended, "rejected tasks are never resumed")
        XCTAssertTrue(client.calls.isEmpty)
    }

    override func tearDown() {
        AutoMobileNetwork.shared.reset()
        #if DEBUG
            NetworkMockRuleStore.shared.setRules([])
            NetworkMockRuleStore.shared.setFaultRules([])
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: false,
                errorType: nil,
                limit: nil,
                expiresAtEpochMs: nil
            ))
        #endif
        super.tearDown()
    }

    // MARK: - NetworkRequestRecord struct-based API

    func testRecordRequestWithRecord() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }

        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileNetwork.shared.setCaptureHeaders(true)

        let record = NetworkRequestRecord(
            url: "https://api.example.com/users",
            method: "GET",
            requestHeaders: ["Authorization": "Bearer token"],
            statusCode: 200,
            responseHeaders: ["Content-Type": "application/json"],
            responseBodySize: 1024,
            durationMs: 150.0
        )
        AutoMobileNetwork.shared.recordRequest(record)

        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let event = collector.events.first as? SdkNetworkRequestEvent
        XCTAssertEqual(event?.url, "https://api.example.com/users")
        XCTAssertEqual(event?.method, "GET")
        XCTAssertEqual(event?.statusCode, 200)
        XCTAssertEqual(event?.durationMs, 150.0)
        XCTAssertEqual(event?.requestHeaders?["Authorization"], "<redacted>")
        XCTAssertEqual(event?.host, "api.example.com")
        XCTAssertEqual(event?.path, "/users")
    }

    func testRecordRequestWithRecordHeadersNotCapturedByDefault() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }

        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)

        AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
            url: "https://api.example.com/data",
            method: "POST",
            requestHeaders: ["Authorization": "Bearer secret"]
        ))

        buffer.flush()

        let event = collector.events.first as? SdkNetworkRequestEvent
        XCTAssertNil(event?.requestHeaders)
    }

    func testNetworkRequestRecordDefaults() {
        let record = NetworkRequestRecord(url: "https://example.com", method: "GET")
        XCTAssertNil(record.requestHeaders)
        XCTAssertNil(record.requestBodySize)
        XCTAssertNil(record.statusCode)
        XCTAssertNil(record.responseHeaders)
        XCTAssertNil(record.responseBodySize)
        XCTAssertNil(record.durationMs)
        XCTAssertNil(record.error)
        XCTAssertNil(record.requestBody)
        XCTAssertNil(record.responseBody)
        XCTAssertNil(record.contentType)
    }

    // MARK: - Legacy parameter-based API

    func testRecordRequestManually() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }

        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileNetwork.shared.setCaptureHeaders(true)

        AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
            url: "https://api.example.com/users",
            method: "GET",
            requestHeaders: ["Authorization": "Bearer token"],
            statusCode: 200,
            responseHeaders: ["Content-Type": "application/json"],
            responseBodySize: 1024,
            durationMs: 150.0
        ))

        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let event = collector.events.first as? SdkNetworkRequestEvent
        XCTAssertEqual(event?.url, "https://api.example.com/users")
        XCTAssertEqual(event?.method, "GET")
        XCTAssertEqual(event?.statusCode, 200)
        XCTAssertEqual(event?.durationMs, 150.0)
        XCTAssertEqual(event?.requestHeaders?["Authorization"], "<redacted>")
    }

    func testHeadersNotCapturedByDefault() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }

        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        // captureHeaders is false by default

        AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
            url: "https://api.example.com/data",
            method: "POST",
            requestHeaders: ["Authorization": "Bearer secret"]
        ))

        buffer.flush()

        let event = collector.events.first as? SdkNetworkRequestEvent
        XCTAssertNil(event?.requestHeaders)
    }

    // MARK: - WebSocket

    func testRecordWebSocketFrame() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }

        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)

        AutoMobileNetwork.shared.recordWebSocketFrame(
            url: "wss://ws.example.com",
            direction: .received,
            frameType: .text,
            payloadSize: 256
        )

        buffer.flush()

        let event = collector.events.first as? SdkWebSocketFrameEvent
        XCTAssertEqual(event?.url, "wss://ws.example.com")
        XCTAssertEqual(event?.direction, .received)
        XCTAssertEqual(event?.frameType, .text)
        XCTAssertEqual(event?.payloadSize, 256)
    }

    // MARK: - recordFromTask (delegate-based API)

    func testRecordFromTaskWithError() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }
        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileNetwork.shared.setCaptureHeaders(true)

        var request = URLRequest(url: URL(string: "https://api.example.com/fail")!)
        request.httpMethod = "POST"
        request.setValue("Bearer token", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.dataTask(with: request)

        let startTime = Date(timeIntervalSinceNow: -0.25)
        let error = URLError(.notConnectedToInternet)
        AutoMobileNetwork.shared.recordFromTask(task, startTime: startTime, receivedData: nil, error: error)

        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let event = collector.events.first as? SdkNetworkRequestEvent
        XCTAssertEqual(event?.url, "https://api.example.com/fail")
        XCTAssertEqual(event?.method, "POST")
        XCTAssertNotNil(event?.error)
        XCTAssertNil(event?.statusCode)
        XCTAssertEqual(event?.requestHeaders?["Authorization"], "<redacted>")
        XCTAssertNotNil(event?.durationMs)
        XCTAssertGreaterThan(event?.durationMs ?? 0, 0)
    }

    func testRecordFromTaskSuccessWithoutResponseStillRecords() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }
        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)

        var request = URLRequest(url: URL(string: "https://api.example.com/users?page=1")!)
        request.httpMethod = "GET"
        let task = URLSession.shared.dataTask(with: request)

        AutoMobileNetwork.shared.recordFromTask(
            task,
            startTime: Date(timeIntervalSinceNow: -0.1),
            receivedData: nil,
            error: nil
        )

        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let event = collector.events.first as? SdkNetworkRequestEvent
        XCTAssertEqual(event?.url, "https://api.example.com/users?page=1")
        XCTAssertEqual(event?.method, "GET")
        XCTAssertEqual(event?.host, "api.example.com")
        XCTAssertEqual(event?.path, "/users")
        XCTAssertNotNil(event?.durationMs)
    }

    func testRecordFromTaskShortCircuitsWhenDisabled() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }
        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        AutoMobileNetwork.shared.setEnabled(false)

        let task = URLSession.shared.dataTask(with: URL(string: "https://api.example.com/x")!)
        AutoMobileNetwork.shared.recordFromTask(
            task,
            startTime: Date(),
            receivedData: nil,
            error: URLError(.timedOut)
        )

        buffer.flush()
        XCTAssertEqual(collector.events.count, 0)
    }

    // MARK: - Network Mock Rules

    #if DEBUG
        private func makeEventObservingClient() -> EventObservingURLProtocolClient {
            let collector = EventCollector()
            let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
                collector.collect(events)
            }
            AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
            return EventObservingURLProtocolClient(buffer: buffer, collector: collector)
        }

        private func assertRecordedEvent(
            _ client: EventObservingURLProtocolClient,
            url: String,
            error: String?,
            file: StaticString = #filePath,
            line: UInt = #line
        ) {
            let event = client.eventsAtTerminalCallback.first as? SdkNetworkRequestEvent
            XCTAssertEqual(event?.url, url, file: file, line: line)
            XCTAssertEqual(event?.error, error, file: file, line: line)
        }

        func testNetworkMockRuleStoreMatchesWildcardMethodAndRegex() {
            let store = NetworkMockRuleStore()
            store.setRules([
                NetworkMockRuleDTO(
                    mockId: "mock-1",
                    host: "api\\.example\\.com",
                    path: "^/v1/items",
                    method: "*",
                    limit: nil,
                    remaining: nil,
                    statusCode: 503,
                    responseHeaders: ["x-source": "test"],
                    responseBody: "{\"offline\":true}",
                    contentType: "application/json"
                ),
            ])

            let match = store.findMatchingRule(host: "api.example.com", path: "/v1/items/42", method: "POST")

            XCTAssertEqual(match?.mockId, "mock-1")
            XCTAssertEqual(match?.statusCode, 503)
            XCTAssertEqual(match?.responseHeaders["x-source"], "test")
            XCTAssertEqual(match?.responseBody, "{\"offline\":true}")
            XCTAssertEqual(match?.contentType, "application/json")
        }

        func testNetworkMockRuleStoreMatchesExplicitMethodCaseInsensitively() {
            let store = NetworkMockRuleStore()
            store.setRules([
                NetworkMockRuleDTO(
                    mockId: "mock-1",
                    host: "api\\.example\\.com",
                    path: "/users",
                    method: "post",
                    limit: nil,
                    remaining: nil,
                    statusCode: 201,
                    responseHeaders: [:],
                    responseBody: "",
                    contentType: "application/json"
                ),
            ])

            XCTAssertNotNil(store.findMatchingRule(host: "api.example.com", path: "/users", method: "POST"))
            XCTAssertNil(store.findMatchingRule(host: "api.example.com", path: "/users", method: "GET"))
        }

        func testNetworkMockRuleStoreHonorsLimit() {
            let store = NetworkMockRuleStore()
            store.setRules([
                NetworkMockRuleDTO(
                    mockId: "mock-1",
                    host: ".*",
                    path: ".*",
                    method: "*",
                    limit: 1,
                    remaining: 1,
                    statusCode: 204,
                    responseHeaders: [:],
                    responseBody: "",
                    contentType: "application/json"
                ),
            ])

            XCTAssertNotNil(store.findMatchingRule(host: "api.example.com", path: "/one", method: "GET"))
            XCTAssertNil(store.findMatchingRule(host: "api.example.com", path: "/one", method: "GET"))
        }

        func testNetworkMockRuleStoreHonorsErrorSimulationLimitAndExpiry() {
            let dateProvider = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 100))
            let store = NetworkMockRuleStore(dateProvider: dateProvider)
            store.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "http500",
                limit: 1,
                expiresAtEpochMs: 101_000
            ))

            XCTAssertEqual(store.activeErrorSimulation()?.errorType, "http500")
            XCTAssertNil(store.activeErrorSimulation())

            store.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "timeout",
                limit: nil,
                expiresAtEpochMs: 101_000
            ))
            dateProvider.advance(by: 2)

            XCTAssertNil(store.activeErrorSimulation())
        }

        func testNetworkMockRuleStoreClearsErrorSimulationWhenDisabled() {
            let store = NetworkMockRuleStore()
            store.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "http500",
                limit: nil,
                expiresAtEpochMs: nil
            ))

            store.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: false,
                errorType: nil,
                limit: nil,
                expiresAtEpochMs: nil
            ))

            XCTAssertNil(store.activeErrorSimulation())
        }

        func testNetworkMockRuleStoreSkipsInvalidRegexRules() {
            let store = NetworkMockRuleStore()
            store.setRules([
                NetworkMockRuleDTO(
                    mockId: "bad",
                    host: "[",
                    path: ".*",
                    method: "*",
                    limit: nil,
                    remaining: nil,
                    statusCode: 500,
                    responseHeaders: [:],
                    responseBody: "bad",
                    contentType: "application/json"
                ),
                NetworkMockRuleDTO(
                    mockId: "good",
                    host: "api\\.example\\.com",
                    path: "/ok",
                    method: "GET",
                    limit: nil,
                    remaining: nil,
                    statusCode: 200,
                    responseHeaders: [:],
                    responseBody: "ok",
                    contentType: "text/plain"
                ),
            ])

            let match = store.findMatchingRule(host: "api.example.com", path: "/ok", method: "GET")

            XCTAssertEqual(match?.mockId, "good")
            XCTAssertEqual(match?.responseBody, "ok")
        }

        func testFaultRulesMatchTransportAndConsumePerConnection() {
            let store = NetworkMockRuleStore()
            store.setFaultRules([
                NetworkFaultRuleDTO(
                    faultId: "reset-1",
                    transport: .nwConnection,
                    host: "api\\.example\\.com",
                    port: 443,
                    scheme: "https",
                    path: "/stream",
                    method: "CONNECTION",
                    headers: nil,
                    origin: nil,
                    connectionId: nil,
                    sessionId: nil,
                    action: .closeConnection,
                    statusCode: nil,
                    responseHeaders: nil,
                    responseBody: nil,
                    contentType: nil,
                    errorType: "connectionReset",
                    delayMs: nil,
                    bandwidthBytesPerSecond: nil,
                    dropBytes: nil,
                    limit: 1,
                    expiresAtEpochMs: nil,
                    scope: "connection",
                    dryRun: false
                ),
            ])
            let request = { (id: String) in
                NetworkMockRuleStore.FaultRequest(
                    transport: .nwConnection,
                    host: "api.example.com",
                    port: 443,
                    scheme: "https",
                    path: "/stream",
                    method: "CONNECTION",
                    headers: [:],
                    origin: nil,
                    connectionId: id,
                    sessionId: nil
                )
            }

            XCTAssertEqual(store.evaluate(request("a"))?.faultId, "reset-1")
            XCTAssertNil(store.evaluate(request("a")))
            XCTAssertEqual(store.evaluate(request("b"))?.faultId, "reset-1")
        }

        func testFaultRulesMatchHeaderNamesCaseInsensitively() {
            let store = NetworkMockRuleStore()
            store.setFaultRules([
                makeHeaderFaultRule(faultId: "header-1", headers: ["x-test": "1"]),
            ])
            let request = { (headers: [String: String]) in
                NetworkMockRuleStore.FaultRequest(
                    transport: .urlSession, host: "api.example.com", port: 443, scheme: "https",
                    path: "/v1", method: "GET", headers: headers, origin: nil,
                    connectionId: nil, sessionId: nil
                )
            }

            XCTAssertEqual(store.evaluate(request(["X-Test": "1"]))?.faultId, "header-1")
            XCTAssertNil(store.evaluate(request(["X-Test": "2"])))
            XCTAssertNil(store.evaluate(request([:])))
        }

        func testFaultRulesMatchAnyHeaderWithCaseInsensitiveName() {
            let firstValueStore = NetworkMockRuleStore()
            firstValueStore.setFaultRules([
                makeHeaderFaultRule(faultId: "header-1", headers: ["X-TEST": "1"]),
            ])
            let secondValueStore = NetworkMockRuleStore()
            secondValueStore.setFaultRules([
                makeHeaderFaultRule(faultId: "header-2", headers: ["x-test": "2"]),
            ])
            let missingValueStore = NetworkMockRuleStore()
            missingValueStore.setFaultRules([
                makeHeaderFaultRule(faultId: "header-3", headers: ["x-test": "3"]),
            ])
            let request = { (headers: [String: String]) in
                NetworkMockRuleStore.FaultRequest(
                    transport: .urlSession, host: "api.example.com", port: 443, scheme: "https",
                    path: "/v1", method: "GET", headers: headers, origin: nil,
                    connectionId: nil, sessionId: nil
                )
            }

            for _ in 0 ..< 64 {
                for reverseOrder in [false, true] {
                    var headers: [String: String] = [:]
                    if reverseOrder {
                        headers["x-test"] = "2"
                        headers["X-Test"] = "1"
                    } else {
                        headers["X-Test"] = "1"
                        headers["x-test"] = "2"
                    }
                    let faultRequest = request(headers)
                    XCTAssertEqual(firstValueStore.evaluate(faultRequest)?.faultId, "header-1")
                    XCTAssertEqual(secondValueStore.evaluate(faultRequest)?.faultId, "header-2")
                    XCTAssertNil(missingValueStore.evaluate(faultRequest))
                }
            }

            let singleHeaderStore = NetworkMockRuleStore()
            singleHeaderStore.setFaultRules([
                makeHeaderFaultRule(faultId: "single-header", headers: ["x-test": "1"]),
            ])
            XCTAssertEqual(singleHeaderStore.evaluate(request(["X-Test": "1"]))?.faultId, "single-header")
            XCTAssertNil(singleHeaderStore.evaluate(request([:])))
        }

        private func makeHeaderFaultRule(faultId: String, headers: [String: String]) -> NetworkFaultRuleDTO {
            NetworkFaultRuleDTO(
                faultId: faultId,
                transport: .urlSession,
                host: ".*",
                port: nil,
                scheme: nil,
                path: ".*",
                method: "*",
                headers: headers,
                origin: nil,
                connectionId: nil,
                sessionId: nil,
                action: .error,
                statusCode: nil,
                responseHeaders: nil,
                responseBody: nil,
                contentType: nil,
                errorType: "timeout",
                delayMs: nil,
                bandwidthBytesPerSecond: nil,
                dropBytes: nil,
                limit: nil,
                expiresAtEpochMs: nil,
                scope: nil,
                dryRun: false
            )
        }

        func testFaultRulesHonorExpiryAndDryRunWithoutConsuming() {
            let dateProvider = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 100))
            let store = NetworkMockRuleStore(dateProvider: dateProvider)
            let dto = NetworkFaultRuleDTO(
                faultId: "delay-1",
                transport: .urlSession,
                host: ".*",
                port: nil,
                scheme: nil,
                path: ".*",
                method: "*",
                headers: nil,
                origin: nil,
                connectionId: nil,
                sessionId: nil,
                action: .latency,
                statusCode: nil,
                responseHeaders: nil,
                responseBody: nil,
                contentType: nil,
                errorType: nil,
                delayMs: 50,
                bandwidthBytesPerSecond: nil,
                dropBytes: nil,
                limit: 1,
                expiresAtEpochMs: 101_000,
                scope: nil,
                dryRun: true
            )
            store.setFaultRules([dto])
            let request = NetworkMockRuleStore.FaultRequest(
                transport: .urlSession, host: "api.example.com", port: 443, scheme: "https",
                path: "/v1", method: "GET", headers: [:], origin: nil,
                connectionId: nil, sessionId: nil
            )

            XCTAssertEqual(store.evaluate(request)?.delayMs, 50)
            XCTAssertEqual(store.evaluate(request)?.delayMs, 50)
            dateProvider.advance(by: 2)
            XCTAssertNil(store.evaluate(request))
        }

        func testClearSessionDoesNotRemoveRulesForOtherSessions() {
            let store = NetworkMockRuleStore()
            let rule = { (sessionId: String) in
                NetworkFaultRuleDTO(
                    faultId: "fault-\(sessionId)",
                    transport: .urlSession,
                    host: "api\\.example\\.com",
                    port: nil,
                    scheme: nil,
                    path: "/v1",
                    method: "GET",
                    headers: nil,
                    origin: nil,
                    connectionId: nil,
                    sessionId: sessionId,
                    action: .error,
                    statusCode: nil,
                    responseHeaders: nil,
                    responseBody: nil,
                    contentType: nil,
                    errorType: "timeout",
                    delayMs: nil,
                    bandwidthBytesPerSecond: nil,
                    dropBytes: nil,
                    limit: nil,
                    expiresAtEpochMs: nil,
                    scope: "session",
                    dryRun: false
                )
            }
            store.setFaultRules([rule("a"), rule("b")])
            let request = { (sessionId: String) in
                NetworkMockRuleStore.FaultRequest(
                    transport: .urlSession,
                    host: "api.example.com",
                    port: nil,
                    scheme: "https",
                    path: "/v1",
                    method: "GET",
                    headers: [:],
                    origin: nil,
                    connectionId: nil,
                    sessionId: sessionId
                )
            }

            store.clearSession("a")

            XCTAssertNil(store.evaluate(request("a")))
            XCTAssertEqual(store.evaluate(request("b"))?.faultId, "fault-b")
        }

        func testURLProtocolServesMatchingMockResponseAndRecordsRequest() async throws {
            let collector = EventCollector()
            let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
                collector.collect(events)
            }
            AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
            AutoMobileNetwork.shared.setCaptureHeaders(true)
            AutoMobileNetwork.shared.setCaptureBodies(true)
            NetworkMockRuleStore.shared.setRules([
                NetworkMockRuleDTO(
                    mockId: "mock-1",
                    host: "api\\.example\\.com",
                    path: "^/v1/items$",
                    method: "GET",
                    limit: nil,
                    remaining: nil,
                    statusCode: 500,
                    responseHeaders: ["x-mocked": "true"],
                    responseBody: "{\"error\":\"mocked\"}",
                    contentType: "application/json"
                ),
            ])
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
            let session = URLSession(configuration: config)

            let (data, response) = try await session.data(from: URL(string: "https://api.example.com/v1/items")!)

            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 500)
            XCTAssertEqual(String(data: data, encoding: .utf8), "{\"error\":\"mocked\"}")
            XCTAssertEqual((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-mocked"), "true")
            buffer.flush()
            let event = collector.events.first as? SdkNetworkRequestEvent
            XCTAssertEqual(event?.url, "https://api.example.com/v1/items")
            XCTAssertEqual(event?.method, "GET")
            XCTAssertEqual(event?.statusCode, 500)
            XCTAssertEqual(event?.responseBody, "{\"error\":\"mocked\"}")
            XCTAssertEqual(event?.contentType, "application/json")
            XCTAssertEqual(event?.error, "mocked:mock-1")
        }

        func testURLProtocolPrefersMockRuleOverErrorSimulation() async throws {
            let collector = EventCollector()
            let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
                collector.collect(events)
            }
            AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
            AutoMobileNetwork.shared.setCaptureBodies(true)
            NetworkMockRuleStore.shared.setRules([
                NetworkMockRuleDTO(
                    mockId: "mock-1",
                    host: "api\\.example\\.com",
                    path: "^/v1/items$",
                    method: "GET",
                    limit: nil,
                    remaining: nil,
                    statusCode: 418,
                    responseHeaders: ["x-mocked": "true"],
                    responseBody: "mock-wins",
                    contentType: "text/plain"
                ),
            ])
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "timeout",
                limit: nil,
                expiresAtEpochMs: nil
            ))
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
            let session = URLSession(configuration: config)

            let (data, response) = try await session.data(from: URL(string: "https://api.example.com/v1/items")!)

            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 418)
            XCTAssertEqual(String(data: data, encoding: .utf8), "mock-wins")
            XCTAssertEqual((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-mocked"), "true")
            buffer.flush()
            let event = collector.events.first as? SdkNetworkRequestEvent
            XCTAssertEqual(event?.url, "https://api.example.com/v1/items")
            XCTAssertEqual(event?.statusCode, 418)
            XCTAssertEqual(event?.responseBody, "mock-wins")
            XCTAssertEqual(event?.error, "mocked:mock-1")
        }

        func testMockRuleRecordsBeforeFinishCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/items"
            NetworkMockRuleStore.shared.setRules([
                NetworkMockRuleDTO(
                    mockId: "mock-1", host: "api\\.example\\.com", path: "^/v1/items$", method: "GET",
                    limit: nil, remaining: nil, statusCode: 418, responseHeaders: [:],
                    responseBody: "mock-wins", contentType: "text/plain"
                ),
            ])
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true, errorType: "timeout", limit: nil, expiresAtEpochMs: nil
            ))
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)

            proto.startLoading()

            assertRecordedEvent(client, url: url, error: "mocked:mock-1")
        }

        func testFaultResponseRecordsBeforeFinishCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/fault-response"
            NetworkMockRuleStore.shared.setFaultRules([
                NetworkFaultRuleDTO(
                    faultId: "fault-response", transport: .urlSession, host: "api\\.example\\.com",
                    port: nil, scheme: "https", path: "/v1/fault-response", method: "GET",
                    headers: nil, origin: nil, connectionId: nil, sessionId: nil, action: .response,
                    statusCode: 503, responseHeaders: [:], responseBody: "fault", contentType: "text/plain",
                    errorType: nil, delayMs: nil, bandwidthBytesPerSecond: nil, dropBytes: nil,
                    limit: nil, expiresAtEpochMs: nil, scope: nil, dryRun: false
                ),
            ])
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)

            proto.startLoading()

            assertRecordedEvent(client, url: url, error: "fault:fault-response:response")
        }

        func testFaultErrorRecordsBeforeFailureCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/fault-error"
            NetworkMockRuleStore.shared.setFaultRules([
                NetworkFaultRuleDTO(
                    faultId: "fault-error", transport: .urlSession, host: "api\\.example\\.com",
                    port: nil, scheme: "https", path: "/v1/fault-error", method: "GET",
                    headers: nil, origin: nil, connectionId: nil, sessionId: nil, action: .error,
                    statusCode: nil, responseHeaders: nil, responseBody: nil, contentType: nil,
                    errorType: "timeout", delayMs: nil, bandwidthBytesPerSecond: nil, dropBytes: nil,
                    limit: nil, expiresAtEpochMs: nil, scope: nil, dryRun: false
                ),
            ])
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)

            proto.startLoading()

            assertRecordedEvent(client, url: url, error: "fault:fault-error:error")
        }

        func testSimulatedHttp500RecordsBeforeFinishCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/simulated-http500"
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true, errorType: "http500", limit: nil, expiresAtEpochMs: nil
            ))
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)

            proto.startLoading()

            assertRecordedEvent(client, url: url, error: "simulated:http500")
        }

        func testSimulatedErrorRecordsBeforeFailureCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/simulated-timeout"
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true, errorType: "timeout", limit: nil, expiresAtEpochMs: nil
            ))
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)

            proto.startLoading()

            assertRecordedEvent(client, url: url, error: "simulated:timeout")
        }

        func testPassthroughSuccessRecordsBeforeFinishCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/passthrough-success"
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)
            let task = URLSession.shared.dataTask(with: request)

            proto.urlSession(URLSession.shared, task: task, didCompleteWithError: nil)

            assertRecordedEvent(client, url: url, error: nil)
        }

        func testPassthroughFailureRecordsBeforeFailureCallback() {
            let client = makeEventObservingClient()
            let url = "https://api.example.com/v1/passthrough-failure"
            let request = URLRequest(url: URL(string: url)!)
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)
            let task = URLSession.shared.dataTask(with: request)
            let error = URLError(.timedOut)

            proto.urlSession(URLSession.shared, task: task, didCompleteWithError: error)

            assertRecordedEvent(client, url: url, error: error.localizedDescription)
        }

        func testURLProtocolServesSimulatedHttp500AndRecordsRequest() async throws {
            let collector = EventCollector()
            let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
                collector.collect(events)
            }
            AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
            AutoMobileNetwork.shared.setCaptureBodies(true)
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "http500",
                limit: nil,
                expiresAtEpochMs: nil
            ))
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
            let session = URLSession(configuration: config)
            var request = URLRequest(url: URL(string: "https://api.example.com/fail")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{\"query\":\"mutation\"}".utf8)

            let (data, response) = try await session.data(for: request)

            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 500)
            XCTAssertTrue(data.isEmpty)
            buffer.flush()
            let event = collector.events.first as? SdkNetworkRequestEvent
            XCTAssertEqual(event?.url, "https://api.example.com/fail")
            XCTAssertEqual(event?.method, "POST")
            XCTAssertEqual(event?.requestBody, "{\"query\":\"mutation\"}")
            XCTAssertEqual(event?.statusCode, 500)
            XCTAssertEqual(event?.error, "simulated:http500")
        }

        func testURLProtocolCapsSimulatedErrorStreamBodyCapture() async throws {
            let collector = EventCollector()
            let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
                collector.collect(events)
            }
            AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
            AutoMobileNetwork.shared.setCaptureBodies(true)
            AutoMobileNetwork.shared.setMaxBodyBytes(8)
            NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "http500",
                limit: nil,
                expiresAtEpochMs: nil
            ))
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
            let session = URLSession(configuration: config)
            var request = URLRequest(url: URL(string: "https://api.example.com/stream")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBodyStream = InputStream(data: Data("{\"query\":\"mutation with a long payload\"}".utf8))

            let (_, response) = try await session.data(for: request)

            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 500)
            buffer.flush()
            let event = collector.events.first as? SdkNetworkRequestEvent
            XCTAssertEqual(event?.url, "https://api.example.com/stream")
            XCTAssertEqual(event?.method, "POST")
            XCTAssertEqual(event?.requestBody, "{\"query\"")
            XCTAssertEqual(event?.statusCode, 500)
            XCTAssertEqual(event?.error, "simulated:http500")
        }

        func testURLProtocolServesTransportErrorSimulationsAndRecordsRequests() async {
            let cases: [(String, URLError.Code)] = [
                ("timeout", .timedOut),
                ("connectionRefused", .cannotConnectToHost),
                ("dnsFailure", .cannotFindHost),
                ("tlsFailure", .secureConnectionFailed),
            ]

            for (errorType, expectedCode) in cases {
                let collector = EventCollector()
                let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
                    collector.collect(events)
                }
                AutoMobileNetwork.shared.reset()
                AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
                AutoMobileNetwork.shared.setCaptureBodies(true)
                NetworkMockRuleStore.shared.setErrorSimulation(NetworkErrorSimulationDTO(
                    enabled: true,
                    errorType: errorType,
                    limit: nil,
                    expiresAtEpochMs: nil
                ))
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
                let session = URLSession(configuration: config)
                var request = URLRequest(url: URL(string: "https://api.example.com/\(errorType)")!)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = Data("{\"operation\":\"\(errorType)\"}".utf8)

                do {
                    _ = try await session.data(for: request)
                    XCTFail("Expected \(errorType) to fail")
                } catch {
                    XCTAssertEqual((error as? URLError)?.code, expectedCode)
                }

                buffer.flush()
                let event = collector.events.first as? SdkNetworkRequestEvent
                XCTAssertEqual(event?.url, "https://api.example.com/\(errorType)")
                XCTAssertEqual(event?.method, "POST")
                XCTAssertEqual(event?.requestBody, "{\"operation\":\"\(errorType)\"}")
                XCTAssertNil(event?.statusCode)
                XCTAssertEqual(event?.error, "simulated:\(errorType)")
            }
        }
    #endif
}

final class NetworkCaptureRecorderTests: XCTestCase {
    func testNetworkWireVersionEncodingAndLegacyDecoding() throws {
        let event = SdkNetworkRequestEvent(timestamp: 123, url: "https://example.com", method: "GET")
        let encoded = try JSONEncoder().encode(event)
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(payload["schemaVersion"] as? Int, SdkNetworkRequestEvent.currentSchemaVersion)
        XCTAssertEqual(try JSONDecoder().decode(SdkNetworkRequestEvent.self, from: encoded).schemaVersion, 1)
        payload.removeValue(forKey: "schemaVersion")
        let legacy = try JSONSerialization.data(withJSONObject: payload)
        XCTAssertEqual(try JSONDecoder().decode(SdkNetworkRequestEvent.self, from: legacy).schemaVersion, 0)
    }

    func testSharedEmissionRedactsManualHeadersAndBoundsBodies() throws {
        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 10, flushIntervalMs: 60000) { collector.collect($0) }
        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        defer { AutoMobileNetwork.shared.reset() }
        AutoMobileNetwork.shared.setCaptureHeaders(true)
        AutoMobileNetwork.shared.setCaptureBodies(true)
        AutoMobileNetwork.shared.setMaxBodyBytes(4)
        AutoMobileNetwork.shared.recordRequest(NetworkRequestRecord(
            url: "https://example.com", method: "POST",
            requestHeaders: ["Authorization": "secret"], requestBodySize: 12,
            responseHeaders: ["Set-Cookie": "secret"], responseBodySize: 12,
            requestBody: "hello world!", responseBody: "hello world!"
        ))
        buffer.flush()
        let event = try XCTUnwrap(collector.events.first as? SdkNetworkRequestEvent)
        XCTAssertEqual(event.requestHeaders?["Authorization"], "<redacted>")
        XCTAssertEqual(event.responseHeaders?["Set-Cookie"], "<redacted>")
        XCTAssertEqual(event.requestBody, "hell")
        XCTAssertEqual(event.responseBody, "hell")
        XCTAssertEqual(event.requestBodySize, 12)
        XCTAssertEqual(event.responseBodySize, 12)
    }

    func testWritesSerializedNetworkCaptureFixtures() throws {
        guard let outputDirectory = ProcessInfo.processInfo.environment["AUTOMOBILE_FIXTURE_OUT_DIR"] else { return }

        let collector = EventCollector()
        let buffer = SdkEventBuffer(maxBufferSize: 10, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }
        AutoMobileNetwork.shared.initialize(bundleId: "fixture.app", buffer: buffer)
        defer { AutoMobileNetwork.shared.reset() }
        AutoMobileNetwork.shared.setCaptureHeaders(true)
        AutoMobileNetwork.shared.setCaptureBodies(true)
        AutoMobileNetwork.shared.setMaxBodyBytes(16)

        let records = NetworkRecordCollector()
        let recorder = NetworkCaptureRecorder(
            emit: { records.append($0) },
            maxBodyBytes: 32,
            idGenerator: { "fixture-request" }
        )
        let session = URLSessionNetworkCaptureAdapter(recorder: recorder)
        let sessionId = session.begin(
            url: "https://api.example.com/v1/items?token=<redacted>",
            method: "GET",
            connectionId: "session-connection",
            requestHeaders: ["Authorization": "Bearer secret"]
        )
        session.didReceiveMetrics(requestId: sessionId, durationMs: 12.5)
        session.didComplete(requestId: sessionId, statusCode: 204)

        WebSocketNetworkCaptureAdapter(recorder: recorder).recordFrame(
            url: "wss://api.example.com/socket",
            connectionId: "socket-connection",
            direction: .sent,
            frameType: .text,
            payloadSize: 4
        )

        let connection = NWConnectionNetworkCaptureAdapter(recorder: recorder)
        let connectionId = connection.begin(
            endpoint: "tcp://api.example.com:443",
            connectionId: "nw-connection"
        )
        connection.didUpdateState(requestId: connectionId, state: "ready")
        connection.didSend(requestId: connectionId, bytes: 3)
        connection.didCancel(requestId: connectionId)

        // Host delegate callbacks supply timing/content type alongside the adapter record.
        // A failure after receiving a response also retains its observed HTTP status.
        for failed in [false, true] {
            let requestId = session.begin(
                url: "https://api.example.com/v1/full?token=<redacted>",
                method: "POST",
                connectionId: "full-session",
                requestHeaders: ["Authorization": "Bearer secret", "Content-Type": "text/plain"]
            )
            recorder.recordRequestBodyChunk(requestId: requestId, bytes: 64, text: String(repeating: "q", count: 64))
            session.didReceiveResponseHeaders(
                requestId: requestId, headers: ["Set-Cookie": "secret", "Content-Type": "text/plain"]
            )
            session.didReceiveBody(requestId: requestId, bytes: 64, text: String(repeating: "r", count: 64))
            session.didReceiveMetrics(requestId: requestId, durationMs: 12.5)
            if failed {
                session.didFail(requestId: requestId, error: URLError(.timedOut))
            } else {
                session.didComplete(requestId: requestId, statusCode: 201)
            }
        }

        XCTAssertEqual(records.records.count, 5)
        for (index, original) in records.records.enumerated() {
            var record = original
            if index == 1 {
                record.statusCode = 101 // Host-observed WebSocket handshake status.
            }
            if index >= 3 {
                record.durationMs = 22.5
                record.contentType = "text/plain"
                if index == 4 { record.statusCode = 502 }
            }
            AutoMobileNetwork.shared.recordRequest(record)
        }
        buffer.flush()
        XCTAssertEqual(collector.events.count, 5)
        let full = try XCTUnwrap(collector.events.last as? SdkNetworkRequestEvent)
        XCTAssertEqual(full.requestBody, String(repeating: "q", count: 16))
        XCTAssertEqual(full.responseBody, String(repeating: "r", count: 16))
        XCTAssertEqual(full.requestBodySize, 64)
        XCTAssertEqual(full.responseBodySize, 64)
        XCTAssertEqual(full.responseHeaders?["Set-Cookie"], "<redacted>")
        XCTAssertNotNil(full.error)

        let names = ["urlsession", "websocket", "nwconnection", "urlsession-full", "urlsession-error"]
        try FileManager.default.createDirectory(
            atPath: outputDirectory, withIntermediateDirectories: true
        )
        for (name, event) in zip(names, collector.events) {
            guard let event = event as? SdkNetworkRequestEvent else {
                XCTFail("Expected network request event")
                return
            }
            let batch = try SdkEventBatch(
                bundleId: "fixture.app",
                events: [SdkEventEnvelope(event)],
                timestamp: 1_700_000_000_000
            )
            let data = try JSONEncoder().encode(batch)
            try data.write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent("\(name).json"))
        }

        let contractKeys = SdkNetworkRequestEvent.CodingKeys.allCases.map(\.rawValue).sorted()
        var contractData = try JSONEncoder().encode(contractKeys)
        contractData.append(0x0A)
        try contractData.write(
            to: URL(fileURLWithPath: outputDirectory).appendingPathComponent("contract-keys.json")
        )
    }

    /// Single-threaded harness whose `emit` re-enters the recorder. `@unchecked Sendable`
    /// because the whole test runs synchronously on one thread.
    private final class ReentrantEmitHarness: @unchecked Sendable {
        var recorder: NetworkCaptureRecorder?
        var sequences: [UInt64] = []
        var reentered = false
    }

    /// `emit` must run OUTSIDE `emissionLock`: an emit closure that re-enters the recorder
    /// (triggering a second emission) must not deadlock. On the pre-fix code — which held
    /// the non-recursive `emissionLock` across `emit` — the re-entrant emit would deadlock
    /// (this test would hang).
    func testEmitRunsOutsideEmissionLockSoReentrantEmitDoesNotDeadlock() {
        let harness = ReentrantEmitHarness()
        let recorder = NetworkCaptureRecorder(emit: { [harness] record in
            harness.sequences.append(record.sequenceNumber ?? 0)
            if !harness.reentered {
                harness.reentered = true
                if let inner = harness.recorder {
                    let id2 = inner.beginRequest(url: "https://example.com/2")
                    inner.recordCompletion(requestId: id2, statusCode: 200)
                }
            }
        }, idGenerator: { UUID().uuidString })
        harness.recorder = recorder

        let id1 = recorder.beginRequest(url: "https://example.com/1")
        recorder.recordCompletion(requestId: id1, statusCode: 200) // emit → re-entrant emit

        XCTAssertEqual(harness.sequences.count, 2, "the initial and the re-entrant emit both completed")
        XCTAssertEqual(harness.sequences, [1, 2], "sequence numbers stay monotonic across the re-entrant emit")
    }

    func testRecorderEmitsOneCompletedRequestWithStableIdentityAndBoundedBody() {
        let collector = NetworkRecordCollector()
        let recorder = NetworkCaptureRecorder(
            emit: { collector.append($0) },
            maxBodyBytes: 6,
            idGenerator: { "request-1" },
        )

        let requestId = recorder.beginRequest(
            url: "https://api.example.com/items",
            method: "POST",
            connectionId: "connection-1",
            requestHeaders: ["Authorization": "Bearer secret"],
            requestBodySize: 32,
            requestBody: "{\"item\":\"created\"}"
        )
        recorder.recordResponseHeaders(
            requestId: requestId,
            headers: ["Content-Type": "application/json"]
        )
        recorder.recordResponseBodyChunk(
            requestId: requestId,
            bytes: 6,
            text: "{\"ok\":true}"
        )
        recorder.recordCompletion(requestId: requestId, statusCode: 201)
        recorder.recordCompletion(requestId: requestId, statusCode: 500)

        XCTAssertEqual(collector.records.count, 1)
        XCTAssertEqual(collector.records[0].requestId, "request-1")
        XCTAssertEqual(collector.records[0].connectionId, "connection-1")
        XCTAssertEqual(collector.records[0].statusCode, 201)
        XCTAssertEqual(collector.records[0].requestHeaders?["Authorization"], "<redacted>")
        XCTAssertEqual(collector.records[0].responseHeaders?["Content-Type"], "application/json")
        XCTAssertEqual(collector.records[0].responseBodySize, 6)
        XCTAssertEqual(collector.records[0].responseBody, "{\"ok\":")
    }

    func testRecorderRejectsEventsAfterCompletionAndSupportsConcurrentRequests() {
        let collector = NetworkRecordCollector()
        let recorder = NetworkCaptureRecorder(
            emit: { collector.append($0) },
            idGenerator: { UUID().uuidString }
        )
        let group = DispatchGroup()
        let queue = DispatchQueue(label: "network-recorder-test", attributes: .concurrent)

        for index in 0 ..< 20 {
            group.enter()
            queue.async {
                let requestId = recorder.beginRequest(
                    url: "https://api.example.com/\(index)",
                    connectionId: "connection-\(index)"
                )
                recorder.recordResponseBodyChunk(requestId: requestId, bytes: 1)
                recorder.recordCompletion(requestId: requestId, statusCode: 200)
                recorder.recordFailure(requestId: requestId, error: "late failure")
                group.leave()
            }
        }
        group.wait()

        XCTAssertEqual(collector.records.count, 20)
        XCTAssertEqual(Set(collector.records.map(\.requestId)).count, 20)
        XCTAssertTrue(collector.records.allSatisfy { $0.statusCode == 200 && $0.error == nil })
    }

    func testAdaptersForwardTaskAndWebSocketLifecycleToRecorder() {
        let collector = NetworkRecordCollector()
        let recorder = NetworkCaptureRecorder(
            emit: { collector.append($0) },
            idGenerator: { "adapter-request" }
        )
        let taskAdapter = URLSessionNetworkCaptureAdapter(recorder: recorder)
        let requestId = taskAdapter.begin(
            url: "https://api.example.com/task",
            method: "GET",
            connectionId: "session-1"
        )
        taskAdapter.didReceiveResponseHeaders(requestId: requestId, headers: ["x-test": "true"])
        taskAdapter.didReceiveMetrics(requestId: requestId, durationMs: 12.5)
        taskAdapter.didRedirect(requestId: requestId, url: "https://api.example.com/redirected")
        taskAdapter.didAuthenticate(requestId: requestId, method: "server-trust")
        taskAdapter.didComplete(requestId: requestId, statusCode: 204)

        let socketAdapter = WebSocketNetworkCaptureAdapter(recorder: recorder)
        socketAdapter.recordFrame(
            url: "wss://api.example.com/socket",
            connectionId: "socket-1",
            direction: .sent,
            frameType: .text,
            payloadSize: 4
        )

        XCTAssertEqual(collector.records.count, 2)
        XCTAssertEqual(collector.records[0].statusCode, 204)
        XCTAssertEqual(collector.records[0].sequenceNumber, 1)
        XCTAssertEqual(collector.records[0].metadata?["duration_ms"], "12.5")
        XCTAssertEqual(collector.records[0].metadata?["redirect_url"], "https://api.example.com/redirected")
        XCTAssertEqual(collector.records[0].metadata?["authentication_method"], "server-trust")
        XCTAssertEqual(collector.records[1].connectionId, "socket-1")
        XCTAssertEqual(collector.records[1].sequenceNumber, 2)
        XCTAssertEqual(collector.records[1].direction, .sent)
        XCTAssertEqual(collector.records[1].protocolName, "websocket")
    }

    func testRecorderDoesNotEmitWhenDisabledOrSampledOut() {
        let collector = NetworkRecordCollector()
        let disabled = NetworkCaptureRecorder(
            emit: { collector.append($0) },
            isEnabled: { false },
            sampler: { 0 }
        )
        let disabledId = disabled.beginRequest(url: "https://example.com/disabled")
        disabled.recordCompletion(requestId: disabledId, statusCode: 200)

        let sampledOut = NetworkCaptureRecorder(
            emit: { collector.append($0) },
            samplingRate: 0,
            sampler: { 0 }
        )
        let sampledId = sampledOut.beginRequest(url: "https://example.com/sampled")
        sampledOut.recordCompletion(requestId: sampledId, statusCode: 200)

        XCTAssertTrue(collector.records.isEmpty)
    }

    func testRecorderDoesNotRetainBodyWhenPayloadCaptureIsDisabled() {
        let collector = NetworkRecordCollector()
        let recorder = NetworkCaptureRecorder(
            emit: { collector.append($0) },
            maxBodyBytes: 32,
            isBodyCaptureEnabled: { false }
        )

        let requestId = recorder.beginRequest(
            url: "https://example.com/no-body",
            requestBody: "secret request"
        )
        recorder.recordResponseBodyChunk(
            requestId: requestId,
            bytes: 13,
            text: "secret response"
        )
        recorder.recordCompletion(requestId: requestId, statusCode: 200)

        XCTAssertEqual(collector.records.count, 1)
        XCTAssertNil(collector.records.first?.requestBody)
        XCTAssertNil(collector.records.first?.responseBody)
        XCTAssertNil(collector.records.first?.requestBodySize)
        XCTAssertEqual(collector.records.first?.responseBodySize, 13)
    }

    #if DEBUG
        func testConcurrentProtocolDataCallbacksPreserveCaptureAndAllowReentrantStop() throws {
            let collector = EventCollector()
            let buffer = SdkEventBuffer(timerFactory: { FakeTimer() }, onFlush: { collector.collect($0) })
            AutoMobileNetwork.shared.initialize(bundleId: "test.bundle", buffer: buffer)
            AutoMobileNetwork.shared.setCaptureBodies(true)
            AutoMobileNetwork.shared.setMaxBodyBytes(8)
            let request = URLRequest(url: URL(string: "https://example.com/concurrent-callbacks")!)
            let client = RecordingURLProtocolClient(onCallback: { $0.stopLoading() })
            let proto = AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            // Drive delegate callbacks directly. The task is never resumed, so no I/O occurs.
            let task = session.dataTask(with: request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            proto.urlSession(session, dataTask: task, didReceive: response) { disposition in
                XCTAssertEqual(disposition, .allow)
            }

            DispatchQueue.concurrentPerform(iterations: 32) { _ in
                proto.urlSession(session, dataTask: task, didReceive: Data("xx".utf8))
            }
            proto.urlSession(session, task: task, didCompleteWithError: nil)
            buffer.flush()

            let event = try XCTUnwrap(collector.events.first as? SdkNetworkRequestEvent)
            XCTAssertEqual(event.statusCode, 200)
            XCTAssertEqual(event.responseBodySize, 64)
            XCTAssertEqual(event.responseBody, "xxxxxxxx")
            XCTAssertEqual(client.calls.filter { $0 == "didLoad" }.count, 32)
            XCTAssertEqual(client.calls.first, "didReceive")
            XCTAssertEqual(client.calls.last, "finish")
        }

        private func makeDelayedFaultProtocol(client: RecordingURLProtocolClient) -> AutoMobileURLProtocol {
            AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: SdkEventBuffer { _ in })
            NetworkMockRuleStore.shared.setFaultRules([
                NetworkFaultRuleDTO(
                    faultId: "delayed-error", transport: .urlSession, host: nil, port: nil,
                    scheme: nil, path: nil, method: nil, headers: nil, origin: nil,
                    connectionId: nil, sessionId: nil, action: .error, statusCode: nil,
                    responseHeaders: nil, responseBody: nil, contentType: nil, errorType: "timeout",
                    delayMs: 100, bandwidthBytesPerSecond: nil, dropBytes: nil, limit: nil,
                    expiresAtEpochMs: nil, scope: nil, dryRun: false
                ),
            ])
            let request = URLRequest(url: URL(string: "https://api.example.com/v1/x")!)
            return AutoMobileURLProtocol(request: request, cachedResponse: nil, client: client)
        }

        func testConcurrentFaultSchedulerAccessAndFakeCapture() {
            let scheduler = FakeFaultScheduler()
            defer { AutoMobileURLProtocol.faultScheduler = RealFaultScheduler() }
            let calls = OSAllocatedUnfairLock(initialState: 0)

            DispatchQueue.concurrentPerform(iterations: 32) { _ in
                AutoMobileURLProtocol.faultScheduler = scheduler
                AutoMobileURLProtocol.faultScheduler.schedule(delayMs: 100) {
                    calls.withLock { $0 += 1 }
                }
                scheduler.captured?()
            }

            XCTAssertEqual(calls.withLock { $0 }, 32)
        }

        func testReplacingFaultSchedulerReleasesItOutsideStorageLock() {
            final class ReentrantScheduler: FaultScheduling {
                let onDeinit: @Sendable () -> Void
                init(onDeinit: @escaping @Sendable () -> Void) { self.onDeinit = onDeinit }
                func schedule(delayMs _: Int, work: @escaping @Sendable () -> Void) { work() }
                deinit { onDeinit() }
            }

            let releases = OSAllocatedUnfairLock(initialState: 0)
            AutoMobileURLProtocol.faultScheduler = ReentrantScheduler {
                _ = AutoMobileURLProtocol.faultScheduler
                releases.withLock { $0 += 1 }
            }
            AutoMobileURLProtocol.faultScheduler = RealFaultScheduler()

            XCTAssertEqual(releases.withLock { $0 }, 1)
        }

        // The delayed fault fires normally when the protocol has NOT been stopped.
        func testDelayedFaultFiresWhenNotStopped() {
            let scheduler = FakeFaultScheduler()
            AutoMobileURLProtocol.faultScheduler = scheduler
            defer {
                AutoMobileURLProtocol.faultScheduler = RealFaultScheduler()
                NetworkMockRuleStore.shared.setFaultRules([])
            }

            let client = RecordingURLProtocolClient()
            let proto = makeDelayedFaultProtocol(client: client)
            proto.startLoading() // schedules the fault via the fake scheduler (captured, not fired)

            scheduler.captured?() // fire the delayed fault

            XCTAssertEqual(client.calls, ["didFail"], "an un-stopped delayed fault serves the client")
        }

        // A delayed closure fired AFTER stopLoading must not invoke the client:
        // serveFault checks the stopped flag before making client callbacks.
        func testDelayedFaultFiringAfterStopDoesNotCallClient() {
            let scheduler = FakeFaultScheduler()
            AutoMobileURLProtocol.faultScheduler = scheduler
            defer {
                AutoMobileURLProtocol.faultScheduler = RealFaultScheduler()
                NetworkMockRuleStore.shared.setFaultRules([])
            }

            let client = RecordingURLProtocolClient()
            let proto = makeDelayedFaultProtocol(client: client)
            proto.startLoading() // captures the delayed closure
            proto.stopLoading() // marks the protocol stopped

            scheduler.captured?() // fire the (now stale) closure anyway

            XCTAssertTrue(
                client.calls.isEmpty,
                "a delayed fault that fires after stopLoading() must not invoke the client"
            )
        }
    #endif
}

#if DEBUG
    /// Captures the delayed-fault closure so a test can fire it deterministically, instead
    /// of waiting on the real timer.
    private final class FakeFaultScheduler: FaultScheduling {
        private let work = OSAllocatedUnfairLock<(@Sendable () -> Void)?>(initialState: nil)
        var captured: (@Sendable () -> Void)? { work.withLock { $0 } }
        func schedule(delayMs _: Int, work: @escaping @Sendable () -> Void) {
            self.work.withLock { $0 = work }
        }
    }
#endif

/// Records `URLProtocolClient` callbacks so a test can assert a stopped protocol makes none.
private final class RecordingURLProtocolClient: NSObject, URLProtocolClient {
    private let lock = NSLock()
    private var _calls: [String] = []
    private let onCallback: (@Sendable (URLProtocol) -> Void)?

    init(onCallback: (@Sendable (URLProtocol) -> Void)? = nil) {
        self.onCallback = onCallback
        super.init()
    }

    var calls: [String] {
        lock.lock(); defer { lock.unlock() }; return _calls
    }

    private func record(_ name: String) {
        lock.lock(); _calls.append(name); lock.unlock()
    }

    func urlProtocol(_: URLProtocol, wasRedirectedTo _: URLRequest, redirectResponse _: URLResponse) {
        record("redirect")
    }

    func urlProtocol(_: URLProtocol, cachedResponseIsValid _: CachedURLResponse) { record("cached") }
    func urlProtocol(_ proto: URLProtocol, didReceive _: URLResponse, cacheStoragePolicy _: URLCache.StoragePolicy) {
        record("didReceive")
        onCallback?(proto)
    }

    func urlProtocol(_ proto: URLProtocol, didLoad _: Data) {
        record("didLoad")
        onCallback?(proto)
    }

    func urlProtocolDidFinishLoading(_ proto: URLProtocol) {
        record("finish")
        onCallback?(proto)
    }

    func urlProtocol(_: URLProtocol, didFailWithError _: Error) { record("didFail") }
    func urlProtocol(_: URLProtocol, didReceive _: URLAuthenticationChallenge) { record("challenge") }
    func urlProtocol(_: URLProtocol, didCancel _: URLAuthenticationChallenge) { record("cancelChallenge") }
}
