// swiftlint:disable force_unwrapping - fail-fast on bad fixtures is idiomatic in tests.
import Foundation
import os
import XCTest
@testable import XCTestRunner

/// Stubs the HTTP half of `StreamableHTTPMCPClient` through its injected `URLSession` seam, so the
/// response-decoding contract is pinned without a daemon (#6633). Responses are queued and consumed
/// in request order, because `callTool` sends `initialize` before the tool call.
final class StubURLProtocol: URLProtocol {
    struct Stub: Sendable {
        var statusCode = 200
        var headers: [String: String] = [:]
        var body: Data = .init()

        static func eventStream(_ text: String, sessionId: String = "s1") -> Stub {
            Stub(
                statusCode: 200,
                headers: ["Content-Type": "text/event-stream", "mcp-session-id": sessionId],
                body: Data(text.utf8)
            )
        }

        static func json(_ text: String, sessionId: String = "s1") -> Stub {
            Stub(
                statusCode: 200,
                headers: ["Content-Type": "application/json", "mcp-session-id": sessionId],
                body: Data(text.utf8)
            )
        }
    }

    private static let queue = OSAllocatedUnfairLock<[Stub]>(initialState: [])

    static func enqueue(_ stubs: [Stub]) {
        queue.withLock { $0 = stubs }
    }

    static var remaining: Int {
        queue.withLock { $0.count }
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override static func canInit(with _: URLRequest) -> Bool { true }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let next = Self.queue.withLock { stubs -> Stub? in
            stubs.isEmpty ? nil : stubs.removeFirst()
        }
        guard let stub = next, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let response = HTTPURLResponse(
            url: url, statusCode: stub.statusCode, httpVersion: "HTTP/1.1", headerFields: stub.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class StreamableHTTPSSETests: XCTestCase {
    private let endpoint = URL(string: "http://127.0.0.1:9000/auto-mobile/streamable")!

    private func makeClient() throws -> StreamableHTTPMCPClient {
        try StreamableHTTPMCPClient(endpoint: endpoint, session: StubURLProtocol.makeSession())
    }

    private static func okResult(id: Int) -> String {
        "{\"jsonrpc\":\"2.0\",\"id\":\(id),\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}"
    }

    /// The daemon interleaves `:keepalive` comment lines into the POST stream for long tool calls.
    func testCallToolParsesSSEBodyWithKeepaliveComments() throws {
        StubURLProtocol.enqueue([
            .eventStream(":keepalive\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"),
            .eventStream(":keepalive\n\n:keepalive\n\nevent: message\ndata: \(Self.okResult(id: 2))\n\n"),
        ])
        let client = try makeClient()

        let response = try client.callTool(name: "observe", arguments: [:], timeout: 5)

        XCTAssertEqual(response.text, "ok")
        // Exactly two requests: the captured `mcp-session-id` stopped a second `initialize`.
        XCTAssertEqual(StubURLProtocol.remaining, 0)
    }

    func testSSEMultiLineDataPayloadIsJoined() throws {
        StubURLProtocol.enqueue([
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\n"
                    + "data: \"result\":{\"ok\":true}}\n\n"
            ),
        ])
        let client = try makeClient()

        XCTAssertNoThrow(try client.initialize(timeout: 5))
    }

    func testFrameMatchingRequestIdIsSelected() throws {
        let unrelated = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}"
        let mismatched =
            "{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"stale\"}]}}"
        StubURLProtocol.enqueue([
            .eventStream("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"),
            .eventStream(
                "event: message\ndata: \(unrelated)\n\nevent: message\ndata: \(mismatched)\n\n"
                    + "event: message\ndata: \(Self.okResult(id: 2))\n\n"
            ),
        ])
        let client = try makeClient()

        let response = try client.callTool(name: "observe", arguments: [:], timeout: 5)

        XCTAssertEqual(response.text, "ok")
    }

    func testJSONContentTypeStillParsed() throws {
        StubURLProtocol.enqueue([
            .json("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"),
            .json(Self.okResult(id: 2)),
        ])
        let client = try makeClient()

        let response = try client.callTool(name: "observe", arguments: [:], timeout: 5)

        XCTAssertEqual(response.text, "ok")
    }

    func testSSEErrorFrameSurfacesServerError() throws {
        StubURLProtocol.enqueue([
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"boom\"}}\n\n"
            ),
        ])
        let client = try makeClient()

        XCTAssertThrowsError(try client.initialize(timeout: 5)) { error in
            XCTAssertEqual(error as? MCPClientError, .serverError("boom"))
        }
    }

    /// An error belonging to a different request must not fail this one: the fallback is only for
    /// JSON-RPC errors whose id is absent or null.
    func testErrorFrameForAnotherRequestIdIsIgnored() throws {
        StubURLProtocol.enqueue([
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":99,"
                    + "\"error\":{\"code\":-32000,\"message\":\"stale boom\"}}\n\n"
            ),
        ])
        let client = try makeClient()

        XCTAssertThrowsError(try client.initialize(timeout: 5)) { error in
            guard case let .invalidResponse(message)? = error as? MCPClientError else {
                XCTFail("Expected MCPClientError.invalidResponse, got \(error)")
                return
            }
            XCTAssertTrue(message.contains("No SSE frame matched request id 1"), message)
        }
    }

    func testErrorFrameWithNullIdSurfacesServerError() throws {
        StubURLProtocol.enqueue([
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":null,"
                    + "\"error\":{\"code\":-32700,\"message\":\"parse error\"}}\n\n"
            ),
        ])
        let client = try makeClient()

        XCTAssertThrowsError(try client.initialize(timeout: 5)) { error in
            XCTAssertEqual(error as? MCPClientError, .serverError("parse error"))
        }
    }

    func testMalformedSSEFrameThrowsInvalidResponse() throws {
        StubURLProtocol.enqueue([
            .eventStream("event: message\ndata: not-json-at-all\n\n"),
        ])
        let client = try makeClient()

        XCTAssertThrowsError(try client.initialize(timeout: 5)) { error in
            guard case let .invalidResponse(message)? = error as? MCPClientError else {
                XCTFail("Expected MCPClientError.invalidResponse, got \(error)")
                return
            }
            XCTAssertTrue(message.contains("not-json-at-all"), message)
        }
    }

    func testMalformedJSONBodyThrowsInvalidResponse() throws {
        StubURLProtocol.enqueue([
            .json("<html>nope</html>"),
        ])
        let client = try makeClient()

        XCTAssertThrowsError(try client.initialize(timeout: 5)) { error in
            guard case let .invalidResponse(message)? = error as? MCPClientError else {
                XCTFail("Expected MCPClientError.invalidResponse, got \(error)")
                return
            }
            XCTAssertTrue(message.contains("<html>nope</html>"), message)
        }
    }
}

final class SSEEventParserTests: XCTestCase {
    func testSkipsCommentsAndParsesFields() {
        let events = SSEEventParser.parse(":keepalive\n\nevent: message\nid: 7\ndata: {\"a\":1}\n\n")

        XCTAssertEqual(events, [SSEEventParser.Event(name: "message", data: "{\"a\":1}", id: "7")])
    }

    func testJoinsMultipleDataLinesWithNewline() {
        let events = SSEEventParser.parse("data: one\ndata: two\n\n")

        XCTAssertEqual(events.map(\.data), ["one\ntwo"])
    }

    func testDispatchesTrailingEventWithoutBlankLine() {
        let events = SSEEventParser.parse("event: message\ndata: {\"a\":1}")

        XCTAssertEqual(events.map(\.data), ["{\"a\":1}"])
    }

    func testHandlesCRLFAndBareCRLineEndings() {
        let events = SSEEventParser.parse("data: one\r\n\r\ndata: two\r\r")

        XCTAssertEqual(events.map(\.data), ["one", "two"])
    }

    func testFieldWithoutColonAndValueWithoutLeadingSpace() {
        let events = SSEEventParser.parse("data\ndata:x\n\n")

        XCTAssertEqual(events.map(\.data), ["\nx"])
    }

    func testIgnoresEventsWithNoDataAndUnknownFields() {
        let events = SSEEventParser.parse("event: ping\n\nretry: 100\n\nfoo: bar\n\ndata: real\n\n")

        XCTAssertEqual(events.map(\.data), ["real"])
    }
}

// swiftlint:enable force_unwrapping
