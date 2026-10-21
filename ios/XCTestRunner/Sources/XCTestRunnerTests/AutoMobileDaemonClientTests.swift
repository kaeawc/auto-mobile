import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class AutoMobileDaemonClientTests: XCTestCase {
    func testRequestStaysOpenAtBudgetAndAcceptsReplyDuringGrace() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        XCTAssertEqual(scheduler.requestedDelays.last, 7)
        scheduler.advance(by: 5)
        XCTAssertEqual(scheduler.pendingCount, 1)
        XCTAssertFalse(connection.isClosed)
        connection.deliver(TransportFixtures.daemonReply(id: "1"))
        let response = try await call.value
        XCTAssertEqual(response.text, "ok")
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    func testConnectionTimeDoesNotConsumeSendBudget() async throws {
        let connection = AsyncFakeDaemonConnection(pauseConnect: true)
        let scheduler = VirtualDeadlineScheduler()
        let client = AutoMobileDaemonClient(
            socketPath: "/unused", connectionFactory: AsyncFakeDaemonFactory([connection]),
            options: .init(scheduler: scheduler)
        )
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.connects.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 4)
        connection.connectResult?.resume(returning: ())
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        XCTAssertEqual(scheduler.requestedDelays, [5, 7])
        scheduler.advance(by: 6)
        XCTAssertEqual(scheduler.pendingCount, 1)
        connection.deliver(TransportFixtures.daemonReply(id: "1"))
        let response = try await call.value
        XCTAssertEqual(response.text, "ok")
    }

    func testRequestTimesOutOnlyAfterResponseGrace() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        scheduler.advance(by: 6)
        XCTAssertEqual(scheduler.pendingCount, 1)
        scheduler.advance(by: 1)
        await assertTransportFailure(call, .requestFailed("Timed out waiting for daemon response"))
        XCTAssertTrue(connection.isClosed)
    }

    func testBudgetExtensionWhileSleepingAllowsReplyPastOriginalDeadline() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        scheduler.advance(by: 4)
        connection.deliver(budgetFrame(timeoutMs: "15000"))
        try await connection.receives.wait(for: 2)
        scheduler.advance(by: 3)
        try await scheduler.waitForPendingSleep()
        XCTAssertEqual(Array(scheduler.requestedDelays.suffix(2)), [7, 10])
        scheduler.advance(by: 1)
        XCTAssertFalse(connection.isClosed)
        connection.deliver(TransportFixtures.daemonReply(id: "1"))
        let response = try await call.value
        XCTAssertEqual(response.text, "ok")
    }

    func testBudgetExtensionExpiresFromSendRatherThanNotificationTime() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        scheduler.advance(by: 4)
        connection.deliver(budgetFrame(timeoutMs: "15000"))
        try await connection.receives.wait(for: 2)
        scheduler.advance(by: 3)
        try await scheduler.waitForPendingSleep()
        XCTAssertEqual(Array(scheduler.requestedDelays.suffix(2)), [7, 10])
        scheduler.advance(by: 9)
        XCTAssertEqual(scheduler.pendingCount, 1)
        scheduler.advance(by: 1)
        await assertTransportFailure(call, .requestFailed("Timed out waiting for daemon response"))
    }

    func testUnrelatedAndInvalidBudgetFramesDoNotChangeDeadline() async throws {
        let frames = [
            budgetFrame(timeoutMs: "15000", requestId: "other"),
            budgetFrame(timeoutMs: "15000", method: "notifications/other"),
            budgetFrame(timeoutMs: "15000", type: "other"),
            budgetFrame(timeoutMs: "0"), budgetFrame(timeoutMs: "-1"),
            budgetFrame(timeoutMs: #""15000""#), budgetFrame(timeoutMs: "true"),
            budgetFrame(timeoutMs: "null"), budgetFrame(timeoutMs: "{}"),
            Data(
                #"{"type":"daemon_notification","method":"notifications/automobile/requestBudget","requestId":"1"}"#
                    .utf8
            ),
        ]
        for frame in frames {
            let (client, connection, scheduler) = makeBudgetClient()
            let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
            try await connection.receives.wait(for: 1)
            try await scheduler.waitForPendingSleep()
            connection.deliver(frame)
            try await connection.receives.wait(for: 2)
            scheduler.advance(by: 7)
            await assertTransportFailure(call, .requestFailed("Timed out waiting for daemon response"))
        }
    }

    func testMaximumWireBudgetStillGetsFullGrace() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: .infinity) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        scheduler.advance(by: 86400)
        try await scheduler.waitForPendingSleep()
        XCTAssertEqual(Array(scheduler.requestedDelays.suffix(2)), [86400, 2])
        scheduler.advance(by: 1)
        XCTAssertEqual(scheduler.pendingCount, 1)
        scheduler.advance(by: 1)
        await assertTransportFailure(call, .requestFailed("Timed out waiting for daemon response"))
    }

    func testShortenedBudgetTakesEffectAtNextWake() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        connection.deliver(budgetFrame(timeoutMs: "1000"))
        try await connection.receives.wait(for: 2)
        scheduler.advance(by: 3)
        XCTAssertEqual(scheduler.pendingCount, 1, "shortening does not interrupt the current sleep")
        scheduler.advance(by: 4)
        await assertTransportFailure(call, .requestFailed("Timed out waiting for daemon response"))
    }

    func testReadResourceAdoptsFractionalBudgetAndGrace() async throws {
        let (client, connection, scheduler) = makeBudgetClient()
        let call = Task { try await client.readResource(uri: "test", timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.waitForPendingSleep()
        connection.deliver(budgetFrame(timeoutMs: "8500"))
        try await connection.receives.wait(for: 2)
        scheduler.advance(by: 7)
        try await scheduler.waitForPendingSleep()
        XCTAssertEqual(scheduler.requestedDelays.last, 3.5)
        scheduler.advance(by: 3.5)
        await assertTransportFailure(call, .requestFailed("Timed out waiting for daemon response"))
    }

    private func makeBudgetClient()
        -> (AutoMobileDaemonClient, AsyncFakeDaemonConnection, VirtualDeadlineScheduler)
    {
        let connection = AsyncFakeDaemonConnection()
        let scheduler = VirtualDeadlineScheduler()
        let client = AutoMobileDaemonClient(
            socketPath: "/unused", connectionFactory: AsyncFakeDaemonFactory([connection]),
            options: .init(scheduler: scheduler)
        )
        return (client, connection, scheduler)
    }

    private func budgetFrame(
        timeoutMs: String, requestId: String = "1",
        method: String = "notifications/automobile/requestBudget", type: String = "daemon_notification"
    )
        -> Data
    {
        Data(#"{"type":"\#(type)","method":"\#(method)","requestId":"\#(requestId)","timeoutMs":\#(timeoutMs)}"#.utf8)
    }

    func testSkipsNonMatchingFrameUntilMatchingReply() async throws {
        let connection = AsyncFakeDaemonConnection()
        connection.deliver(Data(#"{"type":"daemon_notification","method":"changed"}"#.utf8))
        connection.deliver(TransportFixtures.daemonReply(id: "1"))
        let factory = AsyncFakeDaemonFactory([connection])
        let client = AutoMobileDaemonClient(
            socketPath: "/unused", connectionFactory: factory,
            options: .init(scheduler: VirtualDeadlineScheduler())
        )

        let result = try await client.callTool(name: "observe", arguments: [:], timeout: 1)

        XCTAssertEqual(result.text, "ok")
        XCTAssertEqual(factory.creations.count, 1)
        XCTAssertEqual(connection.receives.count, 2)
    }

    func testFailedFrameKeepsItsTypedCodeAndRetryableFlag() async throws {
        let frames: [(String, MCPClientError)] = [
            (
                #"{"id":"1","type":"mcp_response","success":false,"error":"queue","code":"daemon_queue_timeout","retryable":true}"#,
                .refused(.init(
                    code: "daemon_queue_timeout", message: "queue", retryable: true, nextAction: nil, retryAfterMs: nil
                ))
            ),
            (
                #"{"id":"1","type":"mcp_response","success":false,"error":"nope","code":"device_outside_bound_session","retryable":false,"retryAfterMs":-7}"#,
                .refused(.init(
                    code: "device_outside_bound_session", message: "nope", retryable: false, nextAction: nil,
                    retryAfterMs: nil
                ))
            ),
            (#"{"id":"1","type":"mcp_response","success":false,"error":"boom"}"#, .serverError("boom")),
            // A code without the flag (`daemon_queue_timeout` today) keeps the blind retry.
            (
                #"{"id":"1","type":"mcp_response","success":false,"error":"queue","code":"daemon_queue_timeout"}"#,
                .serverError("queue")
            ),
        ]
        for (frame, expected) in frames {
            let connection = AsyncFakeDaemonConnection()
            connection.deliver(Data(frame.utf8))
            let client = AutoMobileDaemonClient(
                socketPath: "/unused", connectionFactory: AsyncFakeDaemonFactory([connection]),
                options: .init(scheduler: VirtualDeadlineScheduler())
            )

            do {
                _ = try await client.callTool(name: "observe", arguments: [:], timeout: 1)
                XCTFail("expected the failed frame to throw")
            } catch {
                XCTAssertEqual(error as? MCPClientError, expected, frame)
            }
        }
    }

    func testReceiveFailureDropsConnectionAndNextRequestReconnects() async throws {
        let failedConnection = AsyncFakeDaemonConnection()
        let recoveredConnection = AsyncFakeDaemonConnection(autoReply: true)
        let factory = AsyncFakeDaemonFactory([failedConnection, recoveredConnection])
        let client = AutoMobileDaemonClient(
            socketPath: "/unused", connectionFactory: factory,
            options: .init(scheduler: VirtualDeadlineScheduler())
        )

        let failed = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 1) }
        try await failedConnection.receives.wait(for: 1)
        failedConnection.fail()
        await assertTransportFailure(failed, .requestFailed("Daemon connection closed"))
        XCTAssertTrue(failedConnection.isClosed)

        let result = try await client.callTool(name: "observe", arguments: [:], timeout: 1)

        XCTAssertEqual(result.text, "ok")
        XCTAssertEqual(factory.creations.count, 2)
        XCTAssertEqual(recoveredConnection.connects.count, 1)
        XCTAssertEqual(AsyncFakeDaemonConnection.requestId(recoveredConnection.sent[0]), "2")
    }

    func testNonFiniteAndHugeTimeoutsCompleteWithoutTrapping() async throws {
        let cases: [(TimeInterval, Int)] = [
            (Double.infinity, 86_400_000),
            (1e300, 86_400_000),
            (Double.nan, 0),
        ]
        for (timeout, expectedMilliseconds) in cases {
            let connection = AsyncFakeDaemonConnection()
            connection.deliver(Data(#"{"type":"daemon_notification","method":"changed"}"#.utf8))
            connection.deliver(TransportFixtures.daemonReply(id: "1"))
            let factory = AsyncFakeDaemonFactory([connection])
            let client = AutoMobileDaemonClient(
                socketPath: "/unused", connectionFactory: factory,
                options: .init(clientVersion: "test", scheduler: VirtualDeadlineScheduler())
            )

            let result = try await client.callTool(name: "observe", arguments: [:], timeout: timeout)

            XCTAssertEqual(result.text, "ok")
            XCTAssertEqual(connection.receives.count, 2)
            let payload = try XCTUnwrap(connection.sent.first)
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
            XCTAssertEqual(request["timeoutMs"] as? Int, expectedMilliseconds)
        }
    }
}
