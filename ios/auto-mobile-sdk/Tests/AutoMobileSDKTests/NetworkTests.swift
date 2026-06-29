import XCTest
@testable import AutoMobileSDK

private final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    var events: [any SdkEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func collect(_ events: [any SdkEvent]) { lock.lock(); _events = events; lock.unlock() }
}

final class AutoMobileNetworkTests: XCTestCase {
    override func tearDown() {
        AutoMobileNetwork.shared.reset()
        NetworkMockRuleStore.shared.setRules([])
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
}
