@testable import AutoMobileSDK
import Foundation
import Network
import XCTest

final class SdkHierarchyServerTests: XCTestCase {
    private final class FakeHierarchyTracker: SdkHierarchyServing {
        var bundleId: String? {
            "test.bundle"
        }

        func getLatestHierarchy() -> SdkViewHierarchy? {
            nil
        }

        func walkNow() -> SdkViewHierarchy {
            fatalError("The lifecycle test does not request a hierarchy")
        }
    }

    private final class TrackingLock: NSLocking, @unchecked Sendable {
        private let underlyingLock = NSLock()
        private let stateLock = NSLock()
        private var _isLocked = false

        /// Signals when another caller tries to acquire the lock while it is held.
        let didAttemptLockWhileHeld = DispatchSemaphore(value: 0)

        var isLocked: Bool {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isLocked
        }

        func lock() {
            stateLock.lock()
            let wasLocked = _isLocked
            stateLock.unlock()
            if wasLocked {
                didAttemptLockWhileHeld.signal()
            }

            underlyingLock.lock()
            stateLock.lock()
            _isLocked = true
            stateLock.unlock()
        }

        func unlock() {
            stateLock.lock()
            _isLocked = false
            stateLock.unlock()
            underlyingLock.unlock()
        }
    }

    /// A listener whose `start(queue:)` cannot finish until the test permits it.
    /// This lets the test inspect the lifecycle lock while `start()` is in its
    /// critical section without binding a real network port.
    private final class BlockingListener: SdkHierarchyListener, @unchecked Sendable {
        var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)?
        var newConnectionHandler: (@Sendable (NWConnection) -> Void)?

        private let stateLock = NSLock()
        private var _isServing = false
        private var _cancelCallCount = 0

        let didEnterStart = DispatchSemaphore(value: 0)
        let mayFinishStart = DispatchSemaphore(value: 0)

        var isServing: Bool {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isServing
        }

        var cancelCallCount: Int {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _cancelCallCount
        }

        func start(queue _: DispatchQueue) {
            didEnterStart.signal()
            mayFinishStart.wait()

            stateLock.lock()
            _isServing = true
            stateLock.unlock()
        }

        func cancel() {
            stateLock.lock()
            _cancelCallCount += 1
            _isServing = false
            stateLock.unlock()
        }
    }

    func testStartKeepsLifecycleLockThroughListenerStartThenStopCancelsListener() {
        let tracker = FakeHierarchyTracker()
        let listener = BlockingListener()
        let lifecycleLock = TrackingLock()
        let server = SdkHierarchyServer(
            tracker: tracker,
            listenerFactory: { listener },
            lifecycleLock: lifecycleLock
        )
        let startReturned = expectation(description: "start returns after the listener starts")
        let stopReturned = expectation(description: "stop returns after cancelling the listener")

        DispatchQueue.global().async {
            server.start()
            startReturned.fulfill()
        }
        XCTAssertEqual(
            listener.didEnterStart.wait(timeout: .now() + 1),
            .success,
            "listener start should be entered"
        )
        XCTAssertTrue(
            lifecycleLock.isLocked,
            "start must retain the lifecycle lock while the listener starts"
        )

        DispatchQueue.global().async {
            server.stop()
            stopReturned.fulfill()
        }

        XCTAssertEqual(
            lifecycleLock.didAttemptLockWhileHeld.wait(timeout: .now() + 1),
            .success,
            "stop must attempt to acquire the lifecycle lock before listener startup can finish"
        )
        listener.mayFinishStart.signal()
        wait(for: [startReturned, stopReturned], timeout: 1)

        XCTAssertEqual(listener.cancelCallCount, 1)
        XCTAssertFalse(listener.isServing, "teardown must not leave a listener serving")
    }
}
