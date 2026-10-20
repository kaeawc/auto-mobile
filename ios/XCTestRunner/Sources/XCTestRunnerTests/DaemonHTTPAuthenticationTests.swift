import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class DaemonHTTPAuthenticationTests: XCTestCase {
    private func client(
        _ performer: AsyncFakeHTTPPerformer,
        tokens: FakeDaemonHTTPTokenProvider,
        scheduler: VirtualDeadlineScheduler = VirtualDeadlineScheduler()
    )
        throws -> StreamableHTTPMCPClient
    {
        try StreamableHTTPMCPClient(
            endpoint: XCTUnwrap(URL(string: "http://unused/auto-mobile/streamable")), performer: performer,
            options: .init(scheduler: scheduler, tokenProvider: tokens)
        )
    }

    private func authorization(_ performer: AsyncFakeHTTPPerformer, _ index: Int) -> String? {
        performer.captured[index].request.value(forHTTPHeaderField: "Authorization")
    }

    func testInitializeToolAndResourceRequestsReadFreshTokens() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let tokens = FakeDaemonHTTPTokenProvider(["initial", "tool", "resource"])
        let client = try client(performer, tokens: tokens)
        let tool = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 1)
        XCTAssertEqual(authorization(performer, 0), "Bearer initial")
        performer.reply(0)
        try await performer.requests.wait(for: 2)
        XCTAssertEqual(authorization(performer, 1), "Bearer tool")
        performer.reply(1)
        _ = try await tool.value

        let resource = Task { try await client.readResource(uri: "test", timeout: 5) }
        try await performer.requests.wait(for: 3)
        XCTAssertEqual(authorization(performer, 2), "Bearer resource")
        performer.reply(
            2,
            data: Data(#"{"result":{"contents":[{"text":"timing"}]}}"#.utf8),
            headers: ["Content-Type": "application/json"]
        )
        let response = try await resource.value
        XCTAssertEqual(response.text, "timing")
        XCTAssertEqual(tokens.reads, 3)
    }

    func testMCPRequestsOmitAuthorizationWithoutToken() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try client(performer, tokens: FakeDaemonHTTPTokenProvider())
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        for index in 0 ... 1 {
            try await performer.requests.wait(for: index + 1)
            XCTAssertNil(authorization(performer, index))
            performer.reply(index)
        }
        _ = try await task.value
    }

    func test401ReReadsTokenAndRetriesSameMCPRequestOnce() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let tokens = FakeDaemonHTTPTokenProvider(["old", "rotated"])
        let client = try client(performer, tokens: tokens)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        performer.reply(0, session: "ignored", status: 401)
        try await performer.requests.wait(for: 2)
        XCTAssertEqual(authorization(performer, 0), "Bearer old")
        XCTAssertEqual(authorization(performer, 1), "Bearer rotated")
        XCTAssertEqual(performer.captured[0].request.httpBody, performer.captured[1].request.httpBody)
        XCTAssertNil(performer.captured[1].request.value(forHTTPHeaderField: "MCP-Session-Id"))
        performer.reply(1)
        try await task.value
        XCTAssertEqual(tokens.reads, 2)
    }

    func testRepeated401StopsAfterOneRetryAndNeverInstallsRejectedSession() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let tokens = FakeDaemonHTTPTokenProvider(["old", nil, "fresh"])
        let client = try client(performer, tokens: tokens)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        performer.reply(0, session: "rejected", status: 401)
        try await performer.requests.wait(for: 2)
        XCTAssertNil(authorization(performer, 1), "Missing refreshed token omits the previous header")
        performer.reply(1, session: "also-rejected", status: 401)
        await assertTransportFailure(task, .requestFailed("HTTP 401"))
        XCTAssertEqual(performer.requests.count, 2)
        XCTAssertEqual(tokens.reads, 2)

        let next = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 3)
        XCTAssertEqual(authorization(performer, 2), "Bearer fresh")
        XCTAssertNil(performer.captured[2].request.value(forHTTPHeaderField: "MCP-Session-Id"))
        performer.reply(2, session: "accepted")
        try await performer.requests.wait(for: 4)
        performer.reply(3)
        _ = try await next.value
    }

    func test401RetryStaysInsideOriginalDeadline() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let scheduler = VirtualDeadlineScheduler()
        let client = try client(performer, tokens: FakeDaemonHTTPTokenProvider(["old", "new"]), scheduler: scheduler)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 4)
        performer.reply(0, status: 401)
        try await performer.requests.wait(for: 2)
        scheduler.advance(by: 1)
        await assertTransportFailure(task, .requestFailed("Request timed out"))
        XCTAssertEqual(performer.cancellations.count, 1)
        XCTAssertFalse(performer.reply(1))
    }

    // HeldSessionControlling currently uses the Unix socket. Exercise the shared HTTP performer
    // directly with a heartbeat request so any HTTP heartbeat gets the same authentication policy.
    func testHTTPHeartbeatHeaderAndRefreshPolicy() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let tokens = FakeDaemonHTTPTokenProvider(["heartbeat-old", "heartbeat-new"])
        let authenticated = AuthenticatedDaemonHTTPRequestPerformer(performer: performer, tokenProvider: tokens)
        var request = try URLRequest(url: XCTUnwrap(URL(string: "http://unused/heartbeat")))
        request.httpMethod = "POST"
        let heartbeatRequest = request
        let task = Task { try await authenticated.perform(heartbeatRequest) }
        try await performer.requests.wait(for: 1)
        XCTAssertEqual(authorization(performer, 0), "Bearer heartbeat-old")
        performer.reply(0, data: Data(), status: 401, headers: [:])
        try await performer.requests.wait(for: 2)
        XCTAssertEqual(authorization(performer, 1), "Bearer heartbeat-new")
        performer.reply(1, data: Data(), headers: [:])
        _ = try await task.value
        XCTAssertEqual(tokens.reads, 2)
    }

    func testHTTPHeartbeatOmitsAuthorizationWithoutToken() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let authenticated = AuthenticatedDaemonHTTPRequestPerformer(
            performer: performer, tokenProvider: FakeDaemonHTTPTokenProvider()
        )
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://unused/heartbeat")))
        let task = Task { try await authenticated.perform(request) }
        try await performer.requests.wait(for: 1)
        XCTAssertNil(authorization(performer, 0))
        performer.reply(0, data: Data(), headers: [:])
        _ = try await task.value
    }
}
