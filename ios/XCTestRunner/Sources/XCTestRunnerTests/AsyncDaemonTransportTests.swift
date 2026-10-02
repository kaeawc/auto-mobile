import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class AsyncDaemonTransportTests: XCTestCase {
    private func makeClient(
        _ connections: [AsyncFakeDaemonConnection], scheduler: VirtualDeadlineScheduler = VirtualDeadlineScheduler(),
        gate: AsyncSerialGate = AsyncSerialGate()
    )
        -> (AutoMobileDaemonClient, AsyncFakeDaemonFactory)
    {
        let factory = AsyncFakeDaemonFactory(connections)
        let client = AutoMobileDaemonClient(
            socketPath: "/unused", connectionFactory: factory,
            options: .init(clientVersion: "test", scheduler: scheduler, gate: gate)
        )
        return (client, factory)
    }

    func testAsyncSuccessSkipsNonMatchingFramesAndPreservesShape() async throws {
        let connection = AsyncFakeDaemonConnection(autoReply: true, interleave: true)
        let (client, _) = makeClient([connection])
        try await client.initialize(timeout: 5)
        let response = try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        XCTAssertEqual(response.text, "ok")
        XCTAssertEqual(connection.receives.count, 2)
        XCTAssertEqual(AsyncFakeDaemonConnection.requestId(connection.sent[0]), "1")
    }

    func testTransportErrorDropsConnectionAndNextCallReconnects() async throws {
        let broken = AsyncFakeDaemonConnection(sendError: URLError(.networkConnectionLost))
        let healthy = AsyncFakeDaemonConnection(autoReply: true)
        let (client, factory) = makeClient([broken, healthy])
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        await assertTransportFailure(first, .requestFailed(URLError(.networkConnectionLost).localizedDescription))
        XCTAssertTrue(broken.isClosed)
        let response = try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        XCTAssertEqual(response.text, "ok")
        XCTAssertEqual(factory.creations.count, 2)
        XCTAssertEqual(AsyncFakeDaemonConnection.requestId(healthy.sent[0]), "2")
    }

    func testDeadlineClosesConnectionRejectsLateResponseAndReconnects() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let connection = AsyncFakeDaemonConnection()
        let healthy = AsyncFakeDaemonConnection(autoReply: true)
        let (client, factory) = makeClient([connection, healthy], scheduler: scheduler)
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("Timed out waiting for daemon response"))
        XCTAssertTrue(connection.isClosed)
        XCTAssertFalse(connection.deliverLate(TransportFixtures.daemonReply(id: "1")))
        let response = try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        XCTAssertEqual(response.text, "ok")
        XCTAssertEqual(factory.creations.count, 2)
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    func testCancellationBeforeSendDoesNotConnectOrSend() async throws {
        let connection = AsyncFakeDaemonConnection()
        let (client, factory) = makeClient([connection])
        let start = SingleResumeCell<Void>()
        let task = Task {
            try await start.wait(cancellable: false)
            return try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        }
        task.cancel()
        start.resume(returning: ())
        await assertTransportCancellation(task)
        XCTAssertEqual(connection.sends.count, 0)
        XCTAssertEqual(factory.creations.count, 0)
    }

    func testCancellationDuringConnectSendsNothingAndDropsConnection() async throws {
        let connection = AsyncFakeDaemonConnection(pauseConnect: true)
        let healthy = AsyncFakeDaemonConnection(autoReply: true)
        let (client, factory) = makeClient([connection, healthy])
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.connects.wait(for: 1)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertEqual(connection.sends.count, 0)
        XCTAssertTrue(connection.isClosed)
        let response = try await client.callTool(name: "observe", arguments: [:], timeout: 5)
        XCTAssertEqual(response.text, "ok")
        XCTAssertEqual(factory.creations.count, 2)
    }

    func testMidFlightCancellationReleasesGateAndReconnects() async throws {
        let queued = TransportEvents()
        let connection = AsyncFakeDaemonConnection()
        let healthy = AsyncFakeDaemonConnection(autoReply: true)
        let (client, factory) = makeClient([connection, healthy], gate: AsyncSerialGate(onQueued: { queued.signal() }))
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 1)
        first.cancel()
        await assertTransportCancellation(first)
        let response = try await second.value
        XCTAssertEqual(response.text, "ok")
        XCTAssertTrue(connection.isClosed)
        XCTAssertFalse(connection.deliverLate(TransportFixtures.daemonReply(id: "1")))
        XCTAssertEqual(factory.creations.count, 2)
    }

    func testCancellationAfterResponseIsNoOp() async throws {
        let connection = AsyncFakeDaemonConnection(autoReply: true)
        let (client, _) = makeClient([connection])
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        let response = try await task.value
        task.cancel()
        let retained = try await task.value
        XCTAssertEqual(response.text, retained.text)
        XCTAssertFalse(connection.isClosed)
    }

    func testResetImmediatelyFailsHolderWhileQueuedRequestsFinish() async throws {
        let queued = TransportEvents()
        let firstConnection = AsyncFakeDaemonConnection()
        let secondConnection = AsyncFakeDaemonConnection(sendError: MCPClientError.requestFailed("closed"))
        let thirdConnection = AsyncFakeDaemonConnection(sendError: MCPClientError.requestFailed("closed"))
        let (client, _) = makeClient(
            [firstConnection, secondConnection, thirdConnection], gate: AsyncSerialGate(onQueued: { queued.signal() })
        )
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await firstConnection.receives.wait(for: 1)
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 1)
        let third = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 2)
        client.resetSession()
        XCTAssertTrue(firstConnection.isClosed)
        await assertTransportFailure(first, .requestFailed("Daemon connection closed"))
        await assertTransportFailure(second, .requestFailed("closed"))
        await assertTransportFailure(third, .requestFailed("closed"))
    }

    func testConcurrentCallsUseFIFOIdsAndCancelledWaiterIsSkipped() async throws {
        let queued = TransportEvents()
        let scheduler = VirtualDeadlineScheduler()
        let connection = AsyncFakeDaemonConnection()
        let (client, _) = makeClient(
            [connection],
            scheduler: scheduler,
            gate: AsyncSerialGate(onQueued: { queued.signal() })
        )
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        let cancelled = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 1)
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 2)
        let third = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 3)
        XCTAssertEqual(scheduler.registered.count, 1, "Queued operations have no deadline yet")
        cancelled.cancel()
        await assertTransportCancellation(cancelled)
        connection.deliver(TransportFixtures.daemonReply(id: "999"))
        try await connection.receives.wait(for: 2)
        connection.deliver(TransportFixtures.daemonReply(id: "1", text: "1"))
        let firstResponse = try await first.value
        try await connection.receives.wait(for: 3)
        connection.deliver(TransportFixtures.daemonReply(id: "2", text: "2"))
        let secondResponse = try await second.value
        try await connection.receives.wait(for: 4)
        connection.deliver(TransportFixtures.daemonReply(id: "3", text: "3"))
        let thirdResponse = try await third.value
        XCTAssertEqual([firstResponse.text, secondResponse.text, thirdResponse.text], ["1", "2", "3"])
        XCTAssertEqual(connection.sent.map(AsyncFakeDaemonConnection.requestId), ["1", "2", "3"])
    }

    func testConnectionCloseFailsHolderAndFailedHolderReleasesGate() async throws {
        let queued = TransportEvents()
        let connection = AsyncFakeDaemonConnection()
        let healthy = AsyncFakeDaemonConnection(autoReply: true)
        let (client, _) = makeClient([connection, healthy], gate: AsyncSerialGate(onQueued: { queued.signal() }))
        let first = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.receives.wait(for: 1)
        let second = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await queued.wait(for: 1)
        connection.fail()
        await assertTransportFailure(first, .requestFailed("Daemon connection closed"))
        let result = try await second.value
        XCTAssertEqual(result.text, "ok")
    }

    func testInitializeDeadlineAndResetDuringHandshake() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let firstConnection = AsyncFakeDaemonConnection(pauseConnect: true)
        let secondConnection = AsyncFakeDaemonConnection(pauseConnect: true)
        let (client, _) = makeClient([firstConnection, secondConnection], scheduler: scheduler)
        let first = Task { try await client.initialize(timeout: 5) }
        try await firstConnection.connects.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(first, .requestFailed("Timed out connecting to daemon socket"))
        let second = Task { try await client.initialize(timeout: 5) }
        try await secondConnection.connects.wait(for: 1)
        client.resetSession()
        await assertTransportFailure(second, .requestFailed("Daemon connection closed"))
    }

    func testToolDeadlineDuringConnectPreservesPhaseMessage() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let connection = AsyncFakeDaemonConnection(pauseConnect: true)
        let (client, _) = makeClient([connection], scheduler: scheduler)
        let task = Task { try await client.callTool(name: "observe", arguments: [:], timeout: 5) }
        try await connection.connects.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("Timed out connecting to daemon socket"))
        XCTAssertEqual(connection.sends.count, 0)
        XCTAssertTrue(connection.isClosed)
    }

    func testReadResourceUsesAsyncTransportAndExistingValidation() async throws {
        let connection = AsyncFakeDaemonConnection(autoReply: true)
        let (client, _) = makeClient([connection])
        // The existing tool fixture intentionally lacks resource contents; do not fabricate a capture.
        let task = Task { try await client.readResource(uri: "test", timeout: 5) }
        await assertTransportFailure(task, .invalidResponse("Missing resource contents"))
        XCTAssertEqual(connection.sends.count, 1)
    }

    func testEncodingFailureDoesNotConnectOrSend() async throws {
        let connection = AsyncFakeDaemonConnection()
        let (client, factory) = makeClient([connection])
        do {
            _ = try await client.callTool(name: "observe", arguments: ["bad": Date()], timeout: 5)
            XCTFail("Expected encoding failure")
        } catch { XCTAssertEqual(error as? MCPClientError, .requestFailed("Failed to encode daemon request")) }
        XCTAssertEqual(factory.creations.count, 0)
        XCTAssertEqual(connection.sends.count, 0)
    }

    func testSyncWrapperSuccessOverNativeAsyncSeam() async throws {
        let connection = AsyncFakeDaemonConnection(autoReply: true)
        let (client, _) = makeClient([connection])
        // The synchronous closure runs on a GCD thread, never the async XCTest executor.
        let result = try await runSyncTransportTest { try client.callTool(name: "observe", arguments: [:], timeout: 5) }
        XCTAssertEqual(result.text, "ok")
        XCTAssertEqual(connection.sends.count, 1)
    }

    func testSyncWrapperDeadlineUsesOnlyVirtualTime() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let connection = AsyncFakeDaemonConnection()
        let (client, _) = makeClient([connection], scheduler: scheduler)
        let task = Task {
            try await runSyncTransportTest { try client.callTool(name: "observe", arguments: [:], timeout: 5) }
        }
        try await connection.receives.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("Timed out waiting for daemon response"))
        XCTAssertTrue(connection.isClosed)
    }
}
