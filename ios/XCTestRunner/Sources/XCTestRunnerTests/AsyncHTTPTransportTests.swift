// swiftlint:disable force_unwrapping - fail-fast on bad fixtures is idiomatic in tests.
import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class AsyncHTTPTransportTests: XCTestCase {
    private func makeClient(
        _ performer: AsyncFakeHTTPPerformer,
        scheduler: VirtualDeadlineScheduler = VirtualDeadlineScheduler()
    )
        throws -> StreamableHTTPMCPClient
    {
        try StreamableHTTPMCPClient(
            endpoint: URL(string: "http://unused/auto-mobile/streamable")!, performer: performer,
            options: .init(scheduler: scheduler)
        )
    }

    private func initialize(_ client: StreamableHTTPMCPClient, _ performer: AsyncFakeHTTPPerformer) async throws {
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        performer.reply(0)
        try await task.value
    }

    func testAsyncCallLazilyInitializesAndCapturesSessionHeader() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 1)
        XCTAssertNil(performer.captured[0].request.value(forHTTPHeaderField: "MCP-Session-Id"))
        performer.reply(0, session: "s1")
        try await performer.requests.wait(for: 2)
        XCTAssertEqual(performer.captured[1].request.value(forHTTPHeaderField: "MCP-Session-Id"), "s1")
        XCTAssertEqual(performer.captured[1].request.timeoutInterval, 5)
        performer.reply(1)
        let response = try await task.value
        XCTAssertEqual(response.text, "ok")
    }

    func testTransportErrorMapsToRequestFailed() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        let error = URLError(.networkConnectionLost)
        performer.fail(0, error: error)
        await assertTransportFailure(task, .requestFailed(error.localizedDescription))
    }

    func testURLSessionTimeoutMapsToSameDeadlineError() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        performer.fail(0, error: URLError(.timedOut))
        await assertTransportFailure(task, .requestFailed("Request timed out"))
    }

    func testDeadlineRejectsLateResponseAndDoesNotInstallLateSession() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let scheduler = VirtualDeadlineScheduler()
        let client = try makeClient(performer, scheduler: scheduler)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("Request timed out"))
        XCTAssertEqual(performer.cancellations.count, 1)
        XCTAssertFalse(performer.reply(0, session: "late"), "The late callback ran and could not resume again")
        let next = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 2)
        XCTAssertNil(performer.captured[1].request.value(forHTTPHeaderField: "MCP-Session-Id"))
        performer.reply(1, session: "fresh")
        try await performer.requests.wait(for: 3)
        XCTAssertEqual(performer.captured[2].request.value(forHTTPHeaderField: "MCP-Session-Id"), "fresh")
        performer.reply(2, session: "fresh")
        let response = try await next.value
        XCTAssertEqual(response.text, "ok")
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    func testToolDeadlineRetainsExistingSessionInsteadOfLateHeader() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let scheduler = VirtualDeadlineScheduler()
        let client = try makeClient(performer, scheduler: scheduler)
        try await initialize(client, performer)
        let baseline = scheduler.registered.count
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 2)
        try await scheduler.registered.wait(for: baseline + 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("Request timed out"))
        XCTAssertFalse(performer.reply(1, session: "late"))
        let next = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 3)
        XCTAssertEqual(performer.captured[2].request.value(forHTTPHeaderField: "MCP-Session-Id"), "s1")
        performer.reply(2)
        _ = try await next.value
    }

    func testCancellationBeforeRequestPerformsNothing() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        let start = SingleResumeCell<Void>()
        let task = Task {
            try await start.wait(cancellable: false)
            return try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }
        task.cancel()
        start.resume(returning: ())
        await assertTransportCancellation(task)
        XCTAssertEqual(performer.requests.count, 0)
    }

    func testMidFlightCancellationCancelsTransportAndRejectsLateCallback() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        try await initialize(client, performer)
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 2)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertEqual(performer.cancellations.count, 1)
        XCTAssertFalse(performer.reply(1, session: "late"))
        let next = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 3)
        XCTAssertEqual(performer.captured[2].request.value(forHTTPHeaderField: "MCP-Session-Id"), "s1")
        performer.reply(2)
        let response = try await next.value
        XCTAssertEqual(response.text, "ok")
    }

    func testCancellationAfterResponseIsNoOp() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 1)
        performer.reply(0)
        try await performer.requests.wait(for: 2)
        performer.reply(1)
        let response = try await task.value
        task.cancel()
        let retained = try await task.value
        XCTAssertEqual(response.text, retained.text)
        XCTAssertEqual(performer.cancellations.count, 0)
    }

    func testTeardownFailsEveryConcurrentPendingCall() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        try await initialize(client, performer)
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        let third = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 4)
        let error = URLError(.networkConnectionLost)
        performer.failAll(error)
        for task in [first, second, third] {
            await assertTransportFailure(task, .requestFailed(error.localizedDescription))
        }
        for index in 1 ... 3 {
            XCTAssertFalse(performer.reply(index))
        }
    }

    func testConcurrentResponsesCanArriveInReverseOrder() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        try await initialize(client, performer)
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 2)
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 3)
        let third = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 4)
        performer.reply(3, text: "third")
        performer.reply(2, text: "second")
        performer.reply(1, text: "first")
        let results = try await [first.value, second.value, third.value]
        XCTAssertEqual(results.map(\.text), ["first", "second", "third"])
        XCTAssertEqual(performer.captured.map { AsyncFakeHTTPPerformer.requestId($0.request) }, [1, 2, 3, 4])
    }

    func test404ReinitializesAndRetriesExactlyOnce() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        try await initialize(client, performer)
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 2)
        performer.reply(1, session: "ignored", status: 404)
        try await performer.requests.wait(for: 3)
        XCTAssertNil(performer.captured[2].request.value(forHTTPHeaderField: "MCP-Session-Id"))
        performer.reply(2, session: "renewed")
        try await performer.requests.wait(for: 4)
        XCTAssertEqual(performer.captured[3].request.value(forHTTPHeaderField: "MCP-Session-Id"), "renewed")
        performer.reply(3, status: 404)
        await assertTransportFailure(task, .sessionExpired)
        XCTAssertEqual(performer.requests.count, 4)
    }

    func testResetDoesNotBlockAndOldResponseCannotRestoreSession() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        try await initialize(client, performer)
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 2)
        client.resetSession()
        performer.reply(1, session: "stale")
        _ = try await first.value
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await performer.requests.wait(for: 3)
        XCTAssertNil(performer.captured[2].request.value(forHTTPHeaderField: "MCP-Session-Id"))
        performer.reply(2, session: "fresh")
        try await performer.requests.wait(for: 4)
        XCTAssertEqual(performer.captured[3].request.value(forHTTPHeaderField: "MCP-Session-Id"), "fresh")
        performer.reply(3)
        _ = try await second.value
    }

    func testReadResourceUsesAsyncTransportAndExistingValidation() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        try await initialize(client, performer)
        let task = Task { try await client.readResource(uri: "test", timeout: 5) }
        try await performer.requests.wait(for: 2)
        performer.reply(1)
        await assertTransportFailure(task, .invalidResponse("Missing resource contents"))
    }

    func testEncodingFailurePerformsNothing() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        do {
            _ = try await client.callTool(name: "observe", arguments: ["bad": Date()], timeout: 5)
            XCTFail("Expected encoding failure")
        } catch { XCTAssertEqual(error as? MCPClientError, .requestFailed("Failed to encode MCP request")) }
        XCTAssertEqual(performer.requests.count, 0)
    }

    func testNativeAsyncSuccess() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let client = try makeClient(performer)
        let task = Task {
            try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }
        try await performer.requests.wait(for: 1)
        performer.reply(0)
        try await performer.requests.wait(for: 2)
        performer.reply(1)
        let response = try await task.value
        XCTAssertEqual(response.text, "ok")
    }

    func testNativeAsyncDeadlineUsesOnlyVirtualTime() async throws {
        let performer = AsyncFakeHTTPPerformer()
        let scheduler = VirtualDeadlineScheduler()
        let client = try makeClient(performer, scheduler: scheduler)
        let task = Task { try await client.initialize(timeout: 5) }
        try await performer.requests.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("Request timed out"))
        XCTAssertEqual(performer.cancellations.count, 1)
    }
}

// swiftlint:enable force_unwrapping
