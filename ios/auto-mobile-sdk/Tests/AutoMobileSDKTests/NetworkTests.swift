// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

import XCTest
@testable import AutoMobileSDK

private final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    var events: [any SdkEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func collect(_ events: [any SdkEvent]) { lock.lock(); _events = events; lock.unlock() }
}

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
    override func tearDown() {
        AutoMobileNetwork.shared.reset()
        #if DEBUG
        NetworkMockRuleStore.shared.setRules([])
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
        XCTAssertEqual(event?.requestHeaders?["Authorization"], "Bearer token")
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
        XCTAssertEqual(event?.requestHeaders?["Authorization"], "Bearer token")
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
        XCTAssertEqual(event?.requestHeaders?["Authorization"], "Bearer token")
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

        for index in 0..<20 {
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
}
