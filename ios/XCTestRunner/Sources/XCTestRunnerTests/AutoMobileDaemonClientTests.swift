import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class AutoMobileDaemonClientTests: XCTestCase {
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
