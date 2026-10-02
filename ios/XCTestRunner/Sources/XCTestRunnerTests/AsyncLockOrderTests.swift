import Foundation
import os
import XCTest
@testable import XCTestRunner

@MainActor
final class AsyncLockOrderTests: XCTestCase {
    /// Observe a detached worker through a cell and XCTest's independent watchdog. Awaiting a
    /// stuck task/group directly would prevent XCTest from reporting a lock-order regression.
    private func runBounded(_ operation: @escaping @Sendable () async throws -> Void) async throws {
        let completed = expectation(description: "All concurrent operations terminated")
        let result = SingleResumeCell<Void>()
        Task.detached {
            do {
                try await operation()
                result.resume(returning: ())
            } catch {
                result.resume(throwing: error)
            }
            completed.fulfill()
        }
        // This is only a failure watchdog; successful synchronization uses events, never sleeps.
        await fulfillment(of: [completed], timeout: 2)
        guard result.isResolved else { return }
        try await result.wait()
    }

    func testGateConcurrentCancellationAndHandoffTerminatesWithoutDuplicateGrants() async throws {
        try await runBounded {
            for round in 0 ..< 4 {
                let queued = TransportEvents()
                let gate = AsyncSerialGate(onQueued: { queued.signal() })
                let grants = GateGrants()
                try await gate.acquire()
                var tasks: [Task<Void, any Error>] = []
                for index in 0 ..< 32 {
                    let task = Task.detached {
                        try await gate.acquire()
                        grants.enter(index)
                        defer {
                            grants.leave()
                            gate.release()
                        }
                        await Task.yield()
                    }
                    tasks.append(task)
                    try await queued.wait(for: index + 1)
                }
                // Vary deterministic cancellation points across rounds: before handoff and
                // concurrently with handoff, including waiters whose grant is already in flight.
                let preCancelled = Set(tasks.indices.filter { ($0 + round).isMultiple(of: 7) })
                for index in preCancelled {
                    tasks[index].cancel()
                }
                let start = TransportEvents()
                let waiters = tasks
                let cancellation = Task.detached {
                    try await start.wait(for: 1)
                    for index in waiters.indices where (index + round).isMultiple(of: 5) {
                        waiters[index].cancel()
                    }
                }
                let handoff = Task.detached {
                    try await start.wait(for: 1)
                    gate.release()
                }
                start.signal()
                try await cancellation.value
                try await handoff.value
                for task in tasks {
                    if case let .failure(error) = await task.result {
                        XCTAssertTrue(error is CancellationError, "\(error)")
                    }
                }
                let snapshot = grants.snapshot
                XCTAssertEqual(snapshot.active, 0)
                XCTAssertEqual(snapshot.violations, 0, "Overlapping ownership or duplicate grant")
                XCTAssertTrue(snapshot.seen.isDisjoint(with: preCancelled))
                // A leaked reservation (including a grant losing to cancellation) blocks this probe.
                try await gate.acquire()
                gate.release()
            }
        }
    }

    func testFakeConnectionDeadlineRacingCancellationAlwaysTerminates() async throws {
        try await runBounded {
            for iteration in 0 ..< 200 {
                let scheduler = VirtualDeadlineScheduler()
                let connection = AsyncFakeDaemonConnection()
                let client = AutoMobileDaemonClient(
                    socketPath: "/unused", connectionFactory: AsyncFakeDaemonFactory([connection]),
                    options: .init(clientVersion: "test", scheduler: scheduler)
                )
                let call = Task.detached {
                    try await client.callTool(name: "observe", arguments: [:], timeout: 1)
                }
                try await connection.receives.wait(for: 1)
                try await scheduler.registered.wait(for: 1)
                let start = TransportEvents()
                let deadline = Task.detached {
                    try await start.wait(for: 1)
                    if iteration.isMultiple(of: 2) { await Task.yield() }
                    scheduler.advance(by: 1)
                }
                let cancellation = Task.detached {
                    try await start.wait(for: 1)
                    if !iteration.isMultiple(of: 2) { await Task.yield() }
                    call.cancel()
                }
                start.signal()
                try await deadline.value
                try await cancellation.value
                switch await call.result {
                case .success: XCTFail("Expected deadline or cancellation")
                case let .failure(error):
                    XCTAssertTrue(
                        error is CancellationError || error as? MCPClientError ==
                            .requestFailed("Timed out waiting for daemon response"), "\(error)"
                    )
                }
                XCTAssertTrue(connection.isClosed)
                XCTAssertEqual(scheduler.pendingCount, 0)
                XCTAssertFalse(connection.deliverLate(TransportFixtures.daemonReply(id: "1")))
            }
        }
    }

    func testFactoryCanResetSessionWithoutHoldingClientLockOrPublishingStaleConnection() async throws {
        try await runBounded {
            let connection = AsyncFakeDaemonConnection()
            let target = OSAllocatedUnfairLock<AutoMobileDaemonClient?>(initialState: nil)
            let gate = AsyncSerialGate()
            let client = AutoMobileDaemonClient(
                socketPath: "/unused",
                connectionFactory: ResettingConnectionFactory(connection: connection, target: target),
                options: .init(clientVersion: "test", scheduler: VirtualDeadlineScheduler(), gate: gate)
            )
            target.withLock { $0 = client }
            defer { target.withLock { $0 = nil } }
            do {
                try await client.initialize(timeout: 1)
                XCTFail("Construction crossing reset must be cancelled")
            } catch {
                XCTAssertEqual(error as? MCPClientError, .requestFailed("Daemon connection closed"))
            }
            XCTAssertTrue(connection.isClosed)
            XCTAssertEqual(connection.connects.count, 1)
            try await gate.acquire()
            gate.release()
        }
    }
}

/// Construction may invoke an injected callback; extract the target before resetting so the
/// regression exercises only the client's factory/reset lock order, without a lock in the fake.
private struct ResettingConnectionFactory: AsyncDaemonLineConnectionFactory {
    let connection: AsyncFakeDaemonConnection
    let target: OSAllocatedUnfairLock<AutoMobileDaemonClient?>

    func makeConnection(socketPath _: String) -> any AsyncDaemonLineConnection {
        let client = target.withLock { $0 }
        client?.resetSession()
        return connection
    }
}

private final class GateGrants: Sendable {
    struct State: Sendable {
        var active = 0
        var violations = 0
        var seen: Set<Int> = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    var snapshot: State { state.withLock { $0 } }

    func enter(_ id: Int) {
        state.withLock { current in
            if current.active != 0 || !current.seen.insert(id).inserted { current.violations += 1 }
            current.active += 1
        }
    }

    func leave() { state.withLock { $0.active -= 1 } }
}
