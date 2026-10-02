// swiftlint:disable force_unwrapping - fail-fast on bad fixtures is idiomatic in tests.
import Foundation
import XCTest
@testable import XCTestRunner

/// Response fixtures are delivered through the async performer, without URLSession or real timers.
private struct HTTPResponseFixture: Sendable {
    let headers: [String: String]
    let body: Data

    static func eventStream(_ text: String, sessionId: String = "s1") -> HTTPResponseFixture {
        HTTPResponseFixture(
            headers: ["Content-Type": "text/event-stream", "mcp-session-id": sessionId], body: Data(text.utf8)
        )
    }

    static func json(_ text: String, sessionId: String = "s1") -> HTTPResponseFixture {
        HTTPResponseFixture(
            headers: ["Content-Type": "application/json", "mcp-session-id": sessionId], body: Data(text.utf8)
        )
    }
}

@MainActor
final class StreamableHTTPSSETests: XCTestCase {
    private func makeClient(_ performer: AsyncFakeHTTPPerformer) throws -> StreamableHTTPMCPClient {
        try StreamableHTTPMCPClient(
            endpoint: URL(string: "http://unused/auto-mobile/streamable")!, performer: performer,
            options: .init(scheduler: VirtualDeadlineScheduler())
        )
    }

    private func respond<Value: Sendable>(
        _ performer: AsyncFakeHTTPPerformer, with fixtures: [HTTPResponseFixture],
        operation: @escaping @Sendable () async throws -> Value
    )
        async throws -> Value
    {
        let task = Task { try await operation() }
        for (index, fixture) in fixtures.enumerated() {
            try await performer.requests.wait(for: index + 1)
            performer.reply(index, data: fixture.body, headers: fixture.headers)
        }
        return try await task.value
    }

    private static func okResult(id: Int) -> String {
        "{\"jsonrpc\":\"2.0\",\"id\":\(id),\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}"
    }

    /// The daemon interleaves `:keepalive` comment lines into the POST stream for long tool calls.
    func testCallToolParsesSSEBodyWithKeepaliveComments() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream(":keepalive\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"),
            .eventStream(":keepalive\n\n:keepalive\n\nevent: message\ndata: \(Self.okResult(id: 2))\n\n"),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        let response = try await respond(performer, with: fixtures) {
            try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }

        XCTAssertEqual(response.text, "ok")
        // Exactly two requests: the captured `mcp-session-id` stopped a second `initialize`.
        XCTAssertEqual(performer.requests.count, 2)
    }

    func testSSEMultiLineDataPayloadIsJoined() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\n"
                    + "data: \"result\":{\"ok\":true}}\n\n"
            ),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        try await respond(performer, with: fixtures) {
            try await client.initialize(timeout: 5)
        }
    }

    func testFrameMatchingRequestIdIsSelected() async throws {
        let unrelated = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}"
        let mismatched =
            "{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"stale\"}]}}"
        let fixtures: [HTTPResponseFixture] = [
            .eventStream("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"),
            .eventStream(
                "event: message\ndata: \(unrelated)\n\nevent: message\ndata: \(mismatched)\n\n"
                    + "event: message\ndata: \(Self.okResult(id: 2))\n\n"
            ),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        let response = try await respond(performer, with: fixtures) {
            try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }

        XCTAssertEqual(response.text, "ok")
    }

    /// A JSON-RPC id is matched by type AND value. `"2"` and `2.5` are different ids from `2`;
    /// adopting either would return an unrelated frame's result to this request.
    func testStringAndFractionalIdFramesAreNotMatched() async throws {
        let stringId =
            "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"string\"}]}}"
        let fractionalId =
            "{\"jsonrpc\":\"2.0\",\"id\":2.5,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"fraction\"}]}}"
        let fixtures: [HTTPResponseFixture] = [
            .eventStream("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"),
            .eventStream(
                "event: message\ndata: \(stringId)\n\nevent: message\ndata: \(fractionalId)\n\n"
                    + "event: message\ndata: \(Self.okResult(id: 2))\n\n"
            ),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        let response = try await respond(performer, with: fixtures) {
            try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }

        XCTAssertEqual(response.text, "ok")
    }

    /// Foundation bridges JSON `true` to an `NSNumber` whose `int64Value` is 1, so a boolean id
    /// must be rejected explicitly rather than read as the numeric id 1.
    func testBooleanIdFrameIsNotMatched() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":true,\"result\":{}}\n\n"),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        await assertAsyncThrowsError {
            try await respond(performer, with: fixtures) {
                try await client.initialize(timeout: 5)
            }
        } verify: { error in
            guard case let .invalidResponse(message)? = error as? MCPClientError else {
                XCTFail("Expected MCPClientError.invalidResponse, got \(error)")
                return
            }
            XCTAssertTrue(message.contains("No SSE frame matched request id 1"), message)
        }
    }

    func testJSONContentTypeStillParsed() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .json("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"),
            .json(Self.okResult(id: 2)),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        let response = try await respond(performer, with: fixtures) {
            try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }

        XCTAssertEqual(response.text, "ok")
    }

    func testSSEErrorFrameSurfacesServerError() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"boom\"}}\n\n"
            ),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        await assertAsyncThrowsError {
            try await respond(performer, with: fixtures) {
                try await client.initialize(timeout: 5)
            }
        } verify: { error in
            XCTAssertEqual(error as? MCPClientError, .serverError("boom"))
        }
    }

    /// An error belonging to a different request must not fail this one: the fallback is only for
    /// JSON-RPC errors whose id is absent or null.
    func testErrorFrameForAnotherRequestIdIsIgnored() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":99,"
                    + "\"error\":{\"code\":-32000,\"message\":\"stale boom\"}}\n\n"
            ),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        await assertAsyncThrowsError {
            try await respond(performer, with: fixtures) {
                try await client.initialize(timeout: 5)
            }
        } verify: { error in
            guard case let .invalidResponse(message)? = error as? MCPClientError else {
                XCTFail("Expected MCPClientError.invalidResponse, got \(error)")
                return
            }
            XCTAssertTrue(message.contains("No SSE frame matched request id 1"), message)
        }
    }

    func testErrorFrameWithNullIdSurfacesServerError() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":null,"
                    + "\"error\":{\"code\":-32700,\"message\":\"parse error\"}}\n\n"
            ),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        await assertAsyncThrowsError {
            try await respond(performer, with: fixtures) {
                try await client.initialize(timeout: 5)
            }
        } verify: { error in
            XCTAssertEqual(error as? MCPClientError, .serverError("parse error"))
        }
    }

    func testMalformedSSEFrameThrowsInvalidResponse() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .eventStream("event: message\ndata: not-json-at-all\n\n"),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        await assertAsyncThrowsError {
            try await respond(performer, with: fixtures) {
                try await client.initialize(timeout: 5)
            }
        } verify: { error in
            guard case let .invalidResponse(message)? = error as? MCPClientError else {
                XCTFail("Expected MCPClientError.invalidResponse, got \(error)")
                return
            }
            XCTAssertTrue(message.contains("not-json-at-all"), message)
        }
    }

    func testMalformedJSONBodyThrowsInvalidResponse() async throws {
        let fixtures: [HTTPResponseFixture] = [
            .json("<html>nope</html>"),
        ]
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)

        await assertAsyncThrowsError {
            try await respond(performer, with: fixtures) {
                try await client.initialize(timeout: 5)
            }
        } verify: { error in
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
