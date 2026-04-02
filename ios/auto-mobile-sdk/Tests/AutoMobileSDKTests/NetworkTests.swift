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

        AutoMobileNetwork.shared.recordRequest(
            url: "https://api.example.com/users",
            method: "GET",
            requestHeaders: ["Authorization": "Bearer token"],
            statusCode: 200,
            responseHeaders: ["Content-Type": "application/json"],
            responseBodySize: 1024,
            durationMs: 150.0
        )

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

        AutoMobileNetwork.shared.recordRequest(
            url: "https://api.example.com/data",
            method: "POST",
            requestHeaders: ["Authorization": "Bearer secret"]
        )

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
}
