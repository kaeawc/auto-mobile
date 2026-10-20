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
            endpoint: XCTUnwrap(URL(string: "http://localhost/auto-mobile/streamable")), performer: performer,
            options: .init(scheduler: scheduler, tokenProvider: tokens)
        )
    }

    private struct EndpointVector: Decodable {
        let url: String
        let daemon: Bool
    }

    func testSharedEndpointVectorsPreserveCallerAuthorizationAndLimitRefresh() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 5 {
            root.deleteLastPathComponent()
        }
        let vectors = try JSONDecoder().decode(
            [EndpointVector].self,
            from: Data(contentsOf: root.appendingPathComponent("test/fixtures/daemon-http-endpoints.json"))
        )
        for vector in vectors {
            for caller in [false, true] {
                let performer = AsyncFakeHTTPPerformer()
                let tokens = FakeDaemonHTTPTokenProvider(["local", "refreshed"])
                let authenticated = AuthenticatedDaemonHTTPRequestPerformer(performer: performer, tokenProvider: tokens)
                var request = try URLRequest(url: XCTUnwrap(URL(string: vector.url)))
                if caller { request.setValue("caller", forHTTPHeaderField: "aUtHoRiZaTiOn") }
                let original = request
                let task = Task { try await authenticated.perform(original) }
                try await performer.requests.wait(for: 1)
                let expected = caller ? "caller" : (vector.daemon ? "Bearer local" : nil)
                XCTAssertEqual(authorization(performer, 0), expected, vector.url)
                performer.reply(0, data: Data(), status: vector.daemon && !caller ? 401 : 200, headers: [:])
                if vector.daemon, !caller {
                    try await performer.requests.wait(for: 2)
                    XCTAssertEqual(authorization(performer, 1), "Bearer refreshed", vector.url)
                    performer.reply(1, data: Data(), status: 401, headers: [:])
                }
                _ = try await task.value
                XCTAssertEqual(tokens.reads, vector.daemon && !caller ? 2 : 0, vector.url)
                XCTAssertEqual(performer.requests.count, vector.daemon && !caller ? 2 : 1, vector.url)
            }
        }
    }

    private struct RejectedPerformer: HTTPRequestPerforming {
        func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: 401, httpVersion: nil, headerFields: nil)
            else { throw URLError(.badURL) }
            return (Data(), response)
        }
    }

    func testRemote401AndCallerAuthorizationDoNotRefreshDaemonCredentials() async throws {
        for endpoint in ["https://example.com/mcp", "http://localhost/mcp"] {
            var request = try URLRequest(url: XCTUnwrap(URL(string: endpoint)))
            if endpoint.contains("localhost") { request.setValue("caller", forHTTPHeaderField: "Authorization") }
            let tokens = FakeDaemonHTTPTokenProvider(["local", "refreshed"])
            let performer = AuthenticatedDaemonHTTPRequestPerformer(
                performer: RejectedPerformer(),
                tokenProvider: tokens
            )
            _ = try await performer.perform(request)
            XCTAssertEqual(tokens.reads, 0)
        }
    }

    func testRemoteClientDoesNotReadDaemonCredentials() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let tokens = FakeDaemonHTTPTokenProvider(["local"])
        let client = try StreamableHTTPMCPClient(
            endpoint: XCTUnwrap(URL(string: "https://example.com/mcp")), performer: performer,
            options: .init(scheduler: VirtualDeadlineScheduler(), tokenProvider: tokens)
        )
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        XCTAssertNil(authorization(performer, 0))
        performer.reply(0)
        try await task.value
        XCTAssertEqual(tokens.reads, 0)
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
        var request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost/heartbeat")))
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
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost/heartbeat")))
        let task = Task { try await authenticated.perform(request) }
        try await performer.requests.wait(for: 1)
        XCTAssertNil(authorization(performer, 0))
        performer.reply(0, data: Data(), headers: [:])
        _ = try await task.value
    }
}
