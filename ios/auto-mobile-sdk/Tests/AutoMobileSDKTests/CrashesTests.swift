// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import AutoMobileSDK
import os
import XCTest

/// A stable C-convention handler used as a stand-in "previous" handler.
private let previousHandlerCalls = OSAllocatedUnfairLock(initialState: 0)
private let countingPreviousHandler: @convention(c) (NSException) -> Void = { _ in
    previousHandlerCalls.withLock { $0 += 1 }
}

private let knownPreviousHandler: @convention(c) (NSException) -> Void = { exception in
    (exception.userInfo?["handlers"] as? FakeUncaughtHandlers)?.previousCalls += 1
}

private let foreignHandler: @convention(c) (NSException) -> Void = { exception in
    guard let handlers = exception.userInfo?["handlers"] as? FakeUncaughtHandlers else { return }
    handlers.foreignCalls += 1
    // Bound a regression's recursive chain so the assertion fails rather than
    // overflowing the stack. A correct chain enters this reporter exactly once.
    guard handlers.foreignCalls == 1 else { return }
    handlers.crashes.handleException(exception)
}

private let replacementHandler: @convention(c) (NSException) -> Void = { exception in
    (exception.userInfo?["handlers"] as? FakeUncaughtHandlers)?.foreignCalls += 1
}

/// Handler accessors run serially under the lifecycle lock; tests join any worker
/// before reading the counters. Exception deliveries are synchronous; no timers start.
private final class FakeUncaughtHandlers: @unchecked Sendable {
    let crashes: AutoMobileCrashes
    var current: (@convention(c) (NSException) -> Void)? = knownPreviousHandler
    var captureCalls = 0
    var installCalls = 0
    var previousCalls = 0
    var foreignCalls = 0
    var screenCalls = 0
    var flushCalls = 0
    var flushedEvents = 0

    init(crashes: AutoMobileCrashes = AutoMobileCrashes.makeTestInstance()) {
        self.crashes = crashes
        crashes.captureUncaughtHandler = { [weak self] in
            guard let self else { return nil }
            self.captureCalls += 1
            return self.current
        }
        crashes.installUncaughtHandler = { [weak self] in
            self?.installCalls += 1
            self?.current = $0
        }
    }

    func makeException() -> NSException {
        NSException(name: NSExceptionName("TestException"), reason: "test", userInfo: ["handlers": self])
    }
}

/// Observe actual contention, rather than assuming a queued worker has reached
/// initialize/reset. Foundation's NSLocking keeps this seam internal to tests.
private final class TrackingLifecycleLock: NSLocking, @unchecked Sendable {
    private let underlyingLock = NSLock()
    private let stateLock = NSLock()
    private var isLocked = false
    let didAttemptLockWhileHeld = DispatchSemaphore(value: 0)

    func lock() {
        stateLock.lock()
        let wasLocked = isLocked
        stateLock.unlock()
        if wasLocked {
            didAttemptLockWhileHeld.signal()
        }
        underlyingLock.lock()
        stateLock.lock()
        isLocked = true
        stateLock.unlock()
    }

    func unlock() {
        stateLock.lock()
        isLocked = false
        stateLock.unlock()
        underlyingLock.unlock()
    }
}

private func rawPointer(_ handler: (@convention(c) (NSException) -> Void)?) -> UnsafeRawPointer? {
    handler.map { unsafeBitCast($0, to: UnsafeRawPointer.self) }
}

final class CrashesTests: XCTestCase {
    private func makeBuffer() -> SdkEventBuffer {
        SdkEventBuffer(maxBufferSize: 10, flushIntervalMs: 60000) { _ in }
    }

    /// initialize must capture the previous handler and reset must restore it —
    /// exercising the captured predecessor through the fake process accessors.
    func testInitializeCapturesPreviousHandlerAndResetRestoresIt() {
        let crashes = AutoMobileCrashes.makeTestInstance()
        var installed: [(@convention(c) (NSException) -> Void)?] = []
        var current: (@convention(c) (NSException) -> Void)? = knownPreviousHandler
        crashes.captureUncaughtHandler = { current }
        crashes.installUncaughtHandler = {
            installed.append($0)
            current = $0
        }

        crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        XCTAssertTrue(crashes.isInitialized)
        XCTAssertEqual(installed.count, 1) // installed our routing handler

        crashes.reset()
        XCTAssertFalse(crashes.isInitialized)
        XCTAssertEqual(installed.count, 2)
        // reset restored exactly the handler initialize captured.
        XCTAssertEqual(rawPointer(installed.last!), rawPointer(knownPreviousHandler))
    }

    func testResetPreservesLaterReporter() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        XCTAssertEqual(handlers.captureCalls, 1)
        XCTAssertEqual(handlers.installCalls, 1)

        handlers.current = foreignHandler
        handlers.crashes.reset()

        XCTAssertFalse(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 2)
        XCTAssertEqual(handlers.installCalls, 1)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(foreignHandler))
    }

    func testDormantHandlerForwardsWithoutReporting() {
        let handlers = FakeUncaughtHandlers()
        let buffer = SdkEventBuffer(maxBufferSize: 10, flushIntervalMs: 60000) { events in
            handlers.flushCalls += 1
            handlers.flushedEvents += events.count
        }
        handlers.crashes.initialize(bundleId: "com.example", buffer: buffer)
        handlers.current = foreignHandler
        handlers.crashes.reset()
        // Set a fresh provider after reset so clearing the old provider alone
        // cannot satisfy this assertion. The global SDK remains enabled.
        XCTAssertTrue(AutoMobileSDK.shared.isEnabled)
        handlers.crashes.currentScreenProvider = {
            handlers.screenCalls += 1
            return "screen"
        }
        defer { handlers.crashes.currentScreenProvider = nil }

        handlers.crashes.handleException(handlers.makeException())
        buffer.flush() // Also detect any added events left unflushed.

        XCTAssertEqual(handlers.previousCalls, 1)
        XCTAssertEqual(handlers.foreignCalls, 0)
        XCTAssertEqual(handlers.screenCalls, 0)
        XCTAssertEqual(handlers.flushCalls, 0)
        XCTAssertEqual(handlers.flushedEvents, 0)
        XCTAssertEqual(handlers.installCalls, 1)
    }

    func testReinitializeReactivatesInsideLaterReporterChain() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        handlers.current = foreignHandler
        handlers.crashes.reset()
        let buffer = SdkEventBuffer(maxBufferSize: 10, flushIntervalMs: 60000) { events in
            handlers.flushCalls += 1
            handlers.flushedEvents += events.count
        }

        handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: buffer)
        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3) // Re-read H1 without saving it as our predecessor.
        XCTAssertEqual(handlers.installCalls, 1)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(foreignHandler))
        XCTAssertTrue(AutoMobileSDK.shared.isEnabled)
        handlers.crashes.currentScreenProvider = {
            handlers.screenCalls += 1
            return "screen"
        }

        // Simulate H1 chaining into this instance's A, then A forwarding to H0.
        handlers.current?(handlers.makeException())

        XCTAssertEqual(handlers.foreignCalls, 1)
        XCTAssertEqual(handlers.previousCalls, 1)
        XCTAssertEqual(handlers.screenCalls, 1)
        XCTAssertEqual(handlers.flushCalls, 1)
        XCTAssertEqual(handlers.flushedEvents, 1)
        handlers.crashes.reset()
        XCTAssertEqual(handlers.installCalls, 1)
    }

    func testReinitializeAfterRestoringOriginalHandlerInstallsAgain() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        let ourHandler = handlers.current
        handlers.crashes.reset()
        XCTAssertEqual(handlers.captureCalls, 2)
        XCTAssertEqual(handlers.installCalls, 2)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(knownPreviousHandler))

        handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: makeBuffer())
        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3)
        XCTAssertEqual(handlers.installCalls, 3)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(ourHandler))
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 1)
        handlers.crashes.reset()
        XCTAssertEqual(handlers.installCalls, 4)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(knownPreviousHandler))
    }

    func testResetWithNilHandlerThenReinitializeDiscardsPreviousHandler() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        let ourHandler = handlers.current
        handlers.current = nil

        handlers.crashes.reset()

        XCTAssertFalse(handlers.crashes.isInitialized)
        XCTAssertNil(handlers.current) // Do not undo the host's intentional clear.
        XCTAssertEqual(handlers.installCalls, 1)
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 0) // Reset discarded the old pre-SDK reporter.

        handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: makeBuffer())

        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3)
        XCTAssertEqual(handlers.installCalls, 2)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(ourHandler))
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 0) // No predecessor was current at re-initialize.
        handlers.crashes.reset()
        XCTAssertNil(handlers.current)
    }

    func testDormantHandlerReplacedByNilThenReinitializeInstallsAgain() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        let ourHandler = handlers.current
        handlers.current = foreignHandler
        handlers.crashes.reset()
        handlers.current = nil

        handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: makeBuffer())

        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3)
        XCTAssertEqual(handlers.installCalls, 2)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(ourHandler))
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 0)
        XCTAssertEqual(handlers.foreignCalls, 0)
        handlers.crashes.reset()
        XCTAssertNil(handlers.current)
    }

    func testDormantHandlerReplacedByDifferentReporterReactivatesInPlace() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        handlers.current = foreignHandler
        handlers.crashes.reset()
        handlers.current = replacementHandler

        handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: makeBuffer())

        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3)
        XCTAssertEqual(handlers.installCalls, 1)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(replacementHandler))
        // Even a replaced reporter is not captured as our predecessor. Deliver
        // directly to the isolated instance, without assuming this reporter chains.
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 1)
        XCTAssertEqual(handlers.foreignCalls, 0)
        handlers.crashes.reset()
        XCTAssertEqual(handlers.installCalls, 1)
    }

    func testDormantOwnHandlerReinitializeKeepsOriginalPredecessor() {
        let handlers = FakeUncaughtHandlers()
        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        let ourHandler = handlers.current
        handlers.current = foreignHandler
        handlers.crashes.reset()
        handlers.current = ourHandler

        handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: makeBuffer())

        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3)
        XCTAssertEqual(handlers.installCalls, 2)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(ourHandler))
        // The foreign reporter bounds any erroneous cycle through it, and this
        // delivery must instead reach the original predecessor exactly once.
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 1)
        XCTAssertEqual(handlers.foreignCalls, 0)
        handlers.crashes.reset()
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(knownPreviousHandler))
    }

    func testInitializeWithOwnHandlerDoesNotCaptureItAsPredecessor() {
        let seed = FakeUncaughtHandlers()
        seed.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        let ourHandler = seed.current
        seed.crashes.reset()
        let handlers = FakeUncaughtHandlers()
        handlers.current = ourHandler

        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        handlers.crashes.reset()

        // Restoring nil proves that the normal (non-dormant) path did not save
        // our process-global routing handler as a predecessor. Guard delivery on
        // this assertion so a regression never invokes the real shared instance.
        XCTAssertNil(handlers.current)
        if handlers.current == nil {
            handlers.crashes.handleException(handlers.makeException())
            XCTAssertEqual(handlers.previousCalls, 0)
        }
    }

    func testInitializeWaitsForResetHandlerTransaction() {
        let lifecycleLock = TrackingLifecycleLock()
        let handlers = FakeUncaughtHandlers(crashes: .makeTestInstance(lifecycleLock: lifecycleLock))
        let buffer = makeBuffer()
        handlers.crashes.initialize(bundleId: "com.example", buffer: buffer)
        let worker = DispatchQueue(label: "CrashesTests.reinitialize")
        let finished = DispatchGroup()
        handlers.crashes.captureUncaughtHandler = { [weak handlers] in
            guard let handlers else { return nil }
            handlers.captureCalls += 1
            let current = handlers.current
            if handlers.captureCalls == 2 {
                finished.enter()
                worker.async {
                    handlers.crashes.initialize(bundleId: "com.reinitialized", buffer: buffer)
                    finished.leave()
                }
                // Reset has already published uninitialized state but has not
                // restored H0 yet. Wait for the worker's actual lock attempt;
                // it cannot capture A until reset finishes restoring H0.
                guard lifecycleLock.didAttemptLockWhileHeld.wait(timeout: .now() + 5) == .success else {
                    XCTFail("re-initialize worker never attempted the lifecycle lock while it was held")
                    return current
                }
            }
            return current
        }

        handlers.crashes.reset()
        // Join only AFTER reset releases the lifecycle lock, including on timeout above.
        guard finished.wait(timeout: .now() + 5) == .success else {
            XCTFail("re-initialize worker did not finish")
            return
        }

        XCTAssertTrue(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 3)
        XCTAssertEqual(handlers.installCalls, 3) // Install A, restore H0, install A.
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 1)
        XCTAssertEqual(handlers.foreignCalls, 0)
        handlers.crashes.reset()
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(knownPreviousHandler))
    }

    func testResetWaitsForInitializeHandlerInstallation() {
        let lifecycleLock = TrackingLifecycleLock()
        let handlers = FakeUncaughtHandlers(crashes: .makeTestInstance(lifecycleLock: lifecycleLock))
        let worker = DispatchQueue(label: "CrashesTests.reset")
        let finished = DispatchGroup()
        handlers.crashes.installUncaughtHandler = { [weak handlers] handler in
            guard let handlers else { return }
            handlers.installCalls += 1
            if handlers.installCalls == 1 {
                finished.enter()
                worker.async {
                    handlers.crashes.reset()
                    finished.leave()
                }
                // Initialization has published active state but has not installed
                // A yet. Reset must wait until the entire transaction completes.
                guard lifecycleLock.didAttemptLockWhileHeld.wait(timeout: .now() + 5) == .success else {
                    XCTFail("reset worker never attempted the lifecycle lock while it was held")
                    return
                }
            }
            handlers.current = handler
        }

        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        // The worker can finish once initialize releases its lock, including on timeout above.
        guard finished.wait(timeout: .now() + 5) == .success else {
            XCTFail("reset worker did not finish")
            return
        }

        XCTAssertFalse(handlers.crashes.isInitialized)
        XCTAssertEqual(handlers.captureCalls, 2)
        XCTAssertEqual(handlers.installCalls, 2)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(knownPreviousHandler))
        handlers.crashes.handleException(handlers.makeException())
        XCTAssertEqual(handlers.previousCalls, 0) // Reset removed the saved predecessor.
    }

    func testHandlerAccessorsCanDeliverExceptionsOnSameAndOtherThread() {
        let handlers = FakeUncaughtHandlers()
        let worker = DispatchQueue(label: "CrashesTests.exception")
        handlers.crashes.captureUncaughtHandler = { [weak handlers] in
            guard let handlers else { return nil }
            handlers.captureCalls += 1
            _ = handlers.crashes.isInitialized
            handlers.crashes.handleException(handlers.makeException())
            worker.sync {
                _ = handlers.crashes.currentScreenProvider
                handlers.crashes.handleException(handlers.makeException())
            }
            return handlers.current
        }
        handlers.crashes.installUncaughtHandler = { [weak handlers] handler in
            guard let handlers else { return }
            handlers.installCalls += 1
            handlers.current = handler
            handlers.crashes.handleException(handlers.makeException())
            worker.sync {
                handlers.crashes.handleException(handlers.makeException())
            }
        }

        handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
        XCTAssertEqual(handlers.previousCalls, 2) // Both install-seam deliveries forward to H0.
        handlers.crashes.reset()
        XCTAssertEqual(handlers.previousCalls, 4) // Both reset-capture deliveries still forward.
        XCTAssertFalse(handlers.crashes.isInitialized)
        XCTAssertEqual(rawPointer(handlers.current), rawPointer(knownPreviousHandler))
    }

    func testResetTwiceDoesNotChangeHandlersAgain() {
        for laterReporterInstalled in [false, true] {
            let handlers = FakeUncaughtHandlers()
            handlers.crashes.initialize(bundleId: "com.example", buffer: makeBuffer())
            if laterReporterInstalled {
                handlers.current = foreignHandler
            }
            handlers.crashes.reset()
            let installsAfterReset = handlers.installCalls
            XCTAssertEqual(installsAfterReset, laterReporterInstalled ? 1 : 2)

            handlers.crashes.reset()

            XCTAssertFalse(handlers.crashes.isInitialized)
            XCTAssertEqual(handlers.captureCalls, 2)
            XCTAssertEqual(handlers.installCalls, installsAfterReset)
            XCTAssertEqual(
                rawPointer(handlers.current),
                rawPointer(laterReporterInstalled ? foreignHandler : knownPreviousHandler)
            )
        }
    }

    /// Concurrent initialize calls are idempotent; the captured predecessor is
    /// published with the initialized state under the lock.
    func testConcurrentInitializeIsThreadSafe() {
        let crashes = AutoMobileCrashes.makeTestInstance()
        crashes.captureUncaughtHandler = { nil }
        crashes.installUncaughtHandler = { _ in }
        let buffer = makeBuffer()

        DispatchQueue.concurrentPerform(iterations: 1000) { _ in
            crashes.initialize(bundleId: "com.example", buffer: buffer)
            _ = crashes.isInitialized
        }

        XCTAssertTrue(crashes.isInitialized)
        crashes.reset()
    }

    /// Concurrent get/set/invoke of `currentScreenProvider` must not race. It was a
    /// plain `public var` read in the exception handler while written from arbitrary
    /// threads (#3632) — now serialized by the class lock, snapshotted before use.
    func testCurrentScreenProviderConcurrentAccessDoesNotCrash() {
        let crashes = AutoMobileCrashes.makeTestInstance()
        DispatchQueue.concurrentPerform(iterations: 2000) { i in
            crashes.currentScreenProvider = { "screen-\(i % 100)" }
            _ = crashes.currentScreenProvider
            _ = crashes.currentScreenProvider?()
        }
        XCTAssertNotNil(crashes.currentScreenProvider)
    }

    /// Replacing the provider must release the previous closure OUTSIDE the lock. If a
    /// captured object's `deinit` re-enters the (non-recursive) lock, releasing the old
    /// closure while still holding it would deadlock. This test would hang on a setter
    /// that releases under the lock; it passes only with release-after-unlock.
    func testReplacingProviderReleasesOldClosureWithoutDeadlock() {
        let crashes = AutoMobileCrashes.makeTestInstance()

        // Single-threaded: the sentinel is created, captured and released on the test thread.
        final class ReentrantSentinel: @unchecked Sendable {
            let crashes: AutoMobileCrashes
            let onDeinit: () -> Void
            init(_ crashes: AutoMobileCrashes, onDeinit: @escaping () -> Void) {
                self.crashes = crashes
                self.onDeinit = onDeinit
            }

            deinit {
                // Re-enter the lock via the getter as the closure is released.
                _ = crashes.currentScreenProvider
                onDeinit()
            }
        }

        var deinitRan = false
        var sentinel: ReentrantSentinel? = ReentrantSentinel(crashes) { deinitRan = true }
        crashes.currentScreenProvider = { [sentinel] in
            _ = sentinel
            return "a"
        }
        sentinel = nil // the provider closure now holds the only reference

        // Replacing the provider releases the old closure → sentinel.deinit re-enters
        // the getter. With release-under-lock this deadlocks; with the fix it returns.
        crashes.currentScreenProvider = { "b" }

        XCTAssertTrue(deinitRan, "the replaced closure's captured object was released")
        XCTAssertEqual(crashes.currentScreenProvider?(), "b")
    }

    @MainActor
    func testCrashPathNeverHopsAndFlushesBeforeChainingWithCacheHitOrMiss() {
        let failures = AutoMobileFailures.shared
        failures.reset()
        defer { failures.reset() }
        let executor = FakeMainThreadExecutor()
        failures.cacheDeviceInfo(executor: executor) {
            SdkDeviceInfo(model: "cached crash device", osVersion: "17", systemName: "iOS")
        }
        let crashes = AutoMobileCrashes.makeTestInstance()
        crashes.captureUncaughtHandler = { countingPreviousHandler }
        crashes.installUncaughtHandler = { _ in }
        previousHandlerCalls.withLock { $0 = 0 }
        let events = OSAllocatedUnfairLock(initialState: [SdkCrashEvent]())
        let chainedAtFlush = OSAllocatedUnfairLock(initialState: [Int]())
        let buffer = SdkEventBuffer(timerFactory: { FakeTimer() }, onFlush: { batch in
            events.withLock { $0 += batch.compactMap { $0 as? SdkCrashEvent } }
            chainedAtFlush.withLock { $0.append(previousHandlerCalls.withLock { $0 }) }
        })
        crashes.initialize(bundleId: "crash.test", buffer: buffer)
        defer { crashes.reset() }
        let exception = NSException(name: .genericException, reason: "fixture", userInfo: nil)
        crashes.handleException(exception)
        XCTAssertEqual(events.withLock { $0.first?.deviceInfo.model }, AutoMobileFailures.fallbackDeviceInfo().model)
        XCTAssertEqual(executor.pendingCount, 1, "crash must not schedule or execute main work")
        executor.runAll()
        crashes.handleException(exception)
        XCTAssertEqual(events.withLock { $0.last?.deviceInfo.model }, "cached crash device")
        XCTAssertEqual(executor.pendingCount, 0)
        XCTAssertEqual(events.withLock { $0.count }, 2)
        XCTAssertEqual(chainedAtFlush.withLock { $0 }, [0, 1])
        XCTAssertEqual(previousHandlerCalls.withLock { $0 }, 2)
    }
}
