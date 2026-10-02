import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class MCPConcurrencyTests: XCTestCase {
    func testResumeBeforeInstallDoubleResumeAndLateCancel() async throws {
        let cell = SingleResumeCell<Int>()
        XCTAssertTrue(cell.resume(returning: 7))
        XCTAssertFalse(cell.resume(returning: 8))
        XCTAssertFalse(cell.cancel())
        let value = try await cell.wait()
        XCTAssertEqual(value, 7)
    }

    func testCancelBeforeInstallAndLateResume() async {
        let cell = SingleResumeCell<Int>()
        XCTAssertTrue(cell.cancel())
        XCTAssertFalse(cell.resume(returning: 7))
        do {
            _ = try await cell.wait()
            XCTFail("Expected cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
    }

    func testErrorBeforeInstall() async {
        let cell = SingleResumeCell<Int>()
        XCTAssertTrue(cell.resume(throwing: MCPClientError.sessionExpired))
        do {
            _ = try await cell.wait()
            XCTFail("Expected stored error")
        } catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
    }

    func testInstallThenResumeThenCancel() async throws {
        let cell = SingleResumeCell<Int>()
        let installed = TransportEvents()
        let task = Task.detached {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    cell.install(continuation)
                    installed.signal()
                }
            } onCancel: {
                cell.cancel()
            }
        }
        try await installed.wait(for: 1)
        XCTAssertTrue(cell.resume(returning: 9))
        task.cancel()
        XCTAssertFalse(cell.cancel())
        let value = try await task.value
        XCTAssertEqual(value, 9)
    }

    func testInstallThenCancelThenError() async throws {
        let cell = SingleResumeCell<Int>()
        let installed = TransportEvents()
        let task = Task.detached {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    cell.install(continuation)
                    installed.signal()
                }
            } onCancel: {
                cell.cancel()
            }
        }
        try await installed.wait(for: 1)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertFalse(cell.resume(throwing: MCPClientError.sessionExpired))
    }

    func testDeadlineOperationWinsAndCancelsTimer() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let operation = SingleResumeCell<Int>()
        let task = Task {
            try await withDeadline(
                seconds: 5,
                scheduler: scheduler,
                timeoutError: MCPClientError.requestFailed("timeout")
            ) {
                try await operation.wait()
            }
        }
        try await scheduler.registered.wait(for: 1)
        operation.resume(returning: 42)
        let value = try await task.value
        XCTAssertEqual(value, 42)
        XCTAssertEqual(scheduler.pendingCount, 0)
        scheduler.advance(by: 5)
        task.cancel()
        let sameValue = try await task.value
        XCTAssertEqual(sameValue, 42)
    }

    func testDeadlineWorkerAndTimerUseCallerPriority() async throws {
        let scheduler = PriorityRecordingDeadlineScheduler()
        let operation = SingleResumeCell<Void>()
        let task = Task.detached(priority: .high) {
            try await withDeadline(
                seconds: 5,
                scheduler: scheduler,
                timeoutError: MCPClientError.requestFailed("timeout")
            ) {
                let priority = Task.currentPriority
                try await operation.wait()
                return priority
            }
        }
        let timerPriority = try await scheduler.priority.wait()
        operation.resume(returning: ())
        let workerPriority = try await task.value
        XCTAssertEqual(workerPriority, .high)
        XCTAssertEqual(timerPriority, .high)
    }

    func testDeadlineWinsDiscardsLateOperationResult() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let operation = SingleResumeCell<Int>()
        let timeout = TransportEvents()
        let started = TransportEvents()
        let task = Task {
            try await withDeadline(
                seconds: 5, scheduler: scheduler, onTimeout: { timeout.signal() },
                timeoutError: MCPClientError.requestFailed("timeout"),
                operation: {
                    started.signal()
                    return try await operation.wait()
                }
            )
        }
        try await started.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertTransportFailure(task, .requestFailed("timeout"))
        XCTAssertEqual(timeout.count, 1)
        XCTAssertFalse(operation.resume(returning: 42))
        scheduler.advance(by: 5)
        XCTAssertEqual(timeout.count, 1)
    }

    func testOuterCancellationCancelsBothDeadlineChildren() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let operation = SingleResumeCell<Int>()
        let started = TransportEvents()
        let task = Task {
            try await withDeadline(
                seconds: 5,
                scheduler: scheduler,
                timeoutError: MCPClientError.requestFailed("timeout")
            ) {
                started.signal()
                return try await operation.wait()
            }
        }
        try await started.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertEqual(scheduler.pendingCount, 0)
        XCTAssertFalse(operation.resume(returning: 42))
    }

    func testVirtualSchedulerOnlyFiresDueWaitersAndRemovesCancelledWaiter() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let first = Task { try await scheduler.sleep(seconds: 2) }
        try await scheduler.registered.wait(for: 1)
        let second = Task { try await scheduler.sleep(seconds: 4) }
        try await scheduler.registered.wait(for: 2)
        scheduler.advance(by: 2)
        try await first.value
        XCTAssertEqual(scheduler.pendingCount, 1)
        second.cancel()
        await assertTransportCancellation(second)
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    func testGateSkipsCancelledWaiterAndPreservesFIFO() async throws {
        let queued = TransportEvents()
        let gate = AsyncSerialGate(onQueued: { queued.signal() })
        try await gate.acquire()
        let cancelled = Task { try await gate.acquire(); gate.release() }
        try await queued.wait(for: 1)
        let next = Task { try await gate.acquire(); gate.release(); return 7 }
        try await queued.wait(for: 2)
        cancelled.cancel()
        await assertTransportCancellation(cancelled)
        gate.release()
        let value = try await next.value
        XCTAssertEqual(value, 7)
        try await gate.acquire()
        gate.release()
    }

    func testCancelledGrantReleasesOwnershipBeforeNextAcquire() async throws {
        let queued = TransportEvents()
        let gate = AsyncSerialGate(onQueued: { queued.signal() })
        try await gate.acquire()
        let waiter = Task { try await gate.acquire(); gate.release() }
        try await queued.wait(for: 1)
        // The waiter is MainActor-isolated, so it cannot run between grant and cancel here.
        gate.release()
        waiter.cancel()
        await assertTransportCancellation(waiter)
        try await gate.acquire()
        gate.release()
    }

    func testGateCancellationBeforeAcquireDoesNotTakeOwnership() async throws {
        let gate = AsyncSerialGate()
        let start = SingleResumeCell<Void>()
        let task = Task {
            try await start.wait(cancellable: false)
            try await gate.acquire()
            gate.release()
        }
        task.cancel()
        start.resume(returning: ())
        await assertTransportCancellation(task)
        try await gate.acquire()
        gate.release()
    }

    func testFailingClientImplementsNativeAsyncRequirements() async {
        let client = FailingMCPClient(error: MCPClientError.sessionExpired)
        do { try await client.initialize(timeout: 1); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
        do { _ = try await client.callTool(name: "observe", arguments: [:], timeout: 1); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
        do { _ = try await client.readResource(uri: "test", timeout: 1); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
    }
}

private struct PriorityRecordingDeadlineScheduler: DeadlineScheduler {
    let priority = SingleResumeCell<TaskPriority>()
    private let gate = SingleResumeCell<Void>()

    func sleep(seconds _: TimeInterval) async throws {
        priority.resume(returning: Task.currentPriority)
        try await gate.wait()
    }
}
