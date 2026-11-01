@testable import AutoMobileSdkWire
import Foundation
import XCTest

final class SdkCancellableContinuationTests: XCTestCase, @unchecked Sendable {
    private enum Failure: Error {
        case timedOut
        case stateCancelled
        case watchdog
    }

    private struct Counts {
        let cleanup: Int
        let resumed: Int
        let body: Int
        let cancelled: Int
    }

    /// The network never completes on its own. Cancellation synchronously reports a terminal
    /// state, just as cancelling a listener/connection can race its state handler.
    private final class NetworkStub: @unchecked Sendable {
        let started = AsyncStream<Void>.makeStream()
        private let lock = NSLock()
        private var handle: SdkContinuationResumeOnce<Int>?
        private var cleanupCount = 0
        private var resumeCount = 0
        private var bodyCount = 0
        private var cancellationCount = 0

        func start(_ handle: SdkContinuationResumeOnce<Int>) {
            lock.withLock {
                self.handle = handle
                bodyCount += 1
            }
            started.continuation.yield(())
            started.continuation.finish()
        }

        func cancel() {
            let handle = lock.withLock {
                cleanupCount += 1
                return self.handle
            }
            // This must lose to CancellationError, even though cleanup runs before resumption.
            handle?.resume(throwing: Failure.stateCancelled)
        }

        func didResume(cancelled: Bool) {
            lock.withLock {
                resumeCount += 1
                if cancelled {
                    cancellationCount += 1
                }
            }
        }

        @discardableResult
        func lateCallback() -> Bool {
            let handle = lock.withLock { self.handle }
            return handle?.resume(throwing: Failure.stateCancelled) ?? false
        }

        func releaseIfStalled() {
            let handle = lock.withLock { resumeCount == 0 ? self.handle : nil }
            handle?.resume(throwing: Failure.watchdog)
        }

        var counts: Counts {
            lock.withLock {
                Counts(cleanup: cleanupCount, resumed: resumeCount, body: bodyCount, cancelled: cancellationCount)
            }
        }

        func wait() async throws -> Int {
            do {
                let value: Int = try await withCancellableCheckedContinuation {
                    self.start($0)
                } onCancel: {
                    self.cancel()
                }
                didResume(cancelled: false)
                return value
            } catch {
                didResume(cancelled: error is CancellationError)
                throw error
            }
        }
    }

    /// Do not race the watchdog in a task group: a broken cancellation implementation would
    /// also keep that group's scope open. The expectation bounds the assertion, then the fake
    /// releases the fake's stalled callback without awaiting the task again on failure.
    private func boundedResult(
        network: NetworkStub,
        _ operation: @escaping @Sendable () async throws -> Int
    )
        async -> Result<Int, Error>
    {
        let finished = expectation(description: "continuation operation finished")
        let task = Task {
            let result: Result<Int, Error>
            do {
                let value = try await operation()
                result = .success(value)
            } catch {
                result = .failure(error)
            }
            finished.fulfill()
            return result
        }
        // Operations use fake sleeps, so the watchdog only bounds stalls and adds no
        // wall-clock cost on the passing path.
        let wait = await XCTWaiter.fulfillment(of: [finished], timeout: 5)
        guard wait == .completed else {
            XCTFail("Operation stalled past the watchdog")
            network.releaseIfStalled()
            task.cancel()
            return .failure(Failure.watchdog)
        }
        return await task.value
    }

    func testTimeoutCancelsStalledContinuationExactlyOnce() async {
        let network = NetworkStub()
        let result = await boundedResult(network: network) {
            try await withSdkTimeout(seconds: 30, timeoutError: Failure.timedOut) {
                try await network.wait()
            } sleep: { _ in
                // The fake timer fires as soon as the network has installed its continuation.
                for await _ in network.started.stream {
                    return
                }
            }
        }
        guard case .failure(Failure.timedOut) = result else {
            return XCTFail("Expected the scenario timeout, got \(result)")
        }
        XCTAssertEqual(network.counts.cleanup, 1)
        XCTAssertEqual(network.counts.resumed, 1)
        XCTAssertEqual(network.counts.cancelled, 1)
        XCTAssertEqual(network.counts.body, 1)
    }

    func testLateStateCallbackAfterCancellationIsAbsorbed() async {
        let network = NetworkStub()
        let result = await boundedResult(network: network) {
            let task = Task { try await network.wait() }
            for await _ in network.started.stream {
                break
            }
            task.cancel()
            return try await task.value
        }
        guard case let .failure(error) = result, error is CancellationError else {
            return XCTFail("Expected cancellation, got \(result)")
        }
        XCTAssertFalse(network.lateCallback())
        XCTAssertFalse(network.lateCallback())
        XCTAssertEqual(network.counts.cleanup, 1)
        XCTAssertEqual(network.counts.resumed, 1)
        XCTAssertEqual(network.counts.cancelled, 1)
    }

    func testCancelBeforeStartSkipsNetworkBody() async {
        let network = NetworkStub()
        let result = await boundedResult(network: network) {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await network.wait()
        }
        guard case let .failure(error) = result, error is CancellationError else {
            return XCTFail("Expected cancellation before start, got \(result)")
        }
        XCTAssertEqual(network.counts.cleanup, 1)
        XCTAssertEqual(network.counts.resumed, 1)
        XCTAssertEqual(network.counts.body, 0)
        XCTAssertEqual(network.counts.cancelled, 1)
    }

    func testSuccessStillReturnsValueAndAbsorbsLaterCompletion() async {
        let network = NetworkStub()
        let result = await boundedResult(network: network) {
            let value: Int = try await withCancellableCheckedContinuation {
                network.start($0)
                $0.resume(returning: 42)
            } onCancel: {
                network.cancel()
            }
            network.didResume(cancelled: false)
            return value
        }
        guard case let .success(value) = result else {
            return XCTFail("Expected success, got \(result)")
        }
        XCTAssertEqual(value, 42)
        XCTAssertFalse(network.lateCallback())
        XCTAssertEqual(network.counts.cleanup, 0)
        XCTAssertEqual(network.counts.resumed, 1)
    }

    func testTimeoutReturnsSuccessfulBodyAndCancelsFakeSleeper() async {
        let sleeper = NetworkStub()
        let result = await boundedResult(network: sleeper) {
            try await withSdkTimeout(seconds: 30, timeoutError: Failure.timedOut) {
                for await _ in sleeper.started.stream {
                    return 42
                }
                throw Failure.watchdog
            } sleep: { _ in
                _ = try await sleeper.wait()
            }
        }
        guard case let .success(value) = result else {
            return XCTFail("Expected the body result, got \(result)")
        }
        XCTAssertEqual(value, 42)
        XCTAssertEqual(sleeper.counts.cleanup, 1)
        XCTAssertEqual(sleeper.counts.resumed, 1)
        XCTAssertEqual(sleeper.counts.cancelled, 1)
    }
}
