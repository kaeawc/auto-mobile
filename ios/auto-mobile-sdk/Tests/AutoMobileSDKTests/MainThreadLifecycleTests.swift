@testable import AutoMobileSDK
import os
import XCTest

final class MainThreadLifecycleTests: XCTestCase {
    @MainActor
    func testProductionExecutorRunsInlineOnMain() {
        let calls = OSAllocatedUnfairLock(initialState: 0)
        MainThreadExecutor().execute { calls.withLock { $0 += 1 } }
        XCTAssertEqual(calls.withLock { $0 }, 1)
    }

    @MainActor
    func testBackgroundLifecycleReturnsBeforeSetupOrTeardownRuns() {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let resources = OSAllocatedUnfairLock(initialState: 0)
        lifecycle.start(setup: { resources.withLock { $0 += 1 } }, teardown: { resources.withLock { $0 -= 1 } })
        XCTAssertEqual(executor.pendingCount, 1)
        XCTAssertEqual(resources.withLock { $0 }, 0)
        executor.runNext()
        XCTAssertEqual(resources.withLock { $0 }, 1)
        lifecycle.stop()
        XCTAssertEqual(executor.pendingCount, 1)
        XCTAssertEqual(resources.withLock { $0 }, 1)
        executor.runNext()
        XCTAssertEqual(resources.withLock { $0 }, 0)
    }

    @MainActor
    func testSetupAfterShutdownIsDropped() {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let setups = OSAllocatedUnfairLock(initialState: 0)
        lifecycle.start(setup: { setups.withLock { $0 += 1 } }, teardown: {})
        lifecycle.stop()
        XCTAssertEqual(executor.pendingCount, 2)
        executor.runAll()
        XCTAssertEqual(setups.withLock { $0 }, 0)
        XCTAssertFalse(lifecycle.isInstalled)
    }

    @MainActor
    func testShutdownBeforeSchedulingDropsReservedSetup() throws {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let generation = try XCTUnwrap(lifecycle.prepare())
        let setups = OSAllocatedUnfairLock(initialState: 0)
        lifecycle.stop()
        lifecycle.schedule(generation: generation, setup: { setups.withLock { $0 += 1 } }, teardown: {})
        executor.runAll()
        XCTAssertEqual(setups.withLock { $0 }, 0)
        XCTAssertFalse(lifecycle.isInstalled)
    }

    @MainActor
    func testShutdownDuringSetupCleansResourcesWithoutHoldingLifecycleLock() {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let resources = OSAllocatedUnfairLock(initialState: 0)
        lifecycle.start(setup: {
            resources.withLock { $0 += 1 }
            lifecycle.stop()
        }, teardown: { resources.withLock { $0 -= 1 } })
        executor.runNext()
        XCTAssertEqual(resources.withLock { $0 }, 0)
        XCTAssertFalse(lifecycle.isInstalled)
        executor.runAll()
        XCTAssertEqual(resources.withLock { $0 }, 0)
    }

    @MainActor
    func testRestartDropsOldSetupAndKeepsNewResources() {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let resources = OSAllocatedUnfairLock(initialState: [String]())
        lifecycle.start(
            setup: { resources.withLock { $0.append("old") } },
            teardown: { resources.withLock { $0.removeAll() } }
        )
        lifecycle.stop()
        lifecycle.start(
            setup: { resources.withLock { $0.append("new") } },
            teardown: { resources.withLock { $0.removeAll() } }
        )
        executor.runAll()
        XCTAssertEqual(resources.withLock { $0 }, ["new"])
        lifecycle.stop()
        executor.runAll()
        XCTAssertEqual(resources.withLock { $0 }, [])
    }

    @MainActor
    func testRestartCleansInstalledResourcesBeforeNewSetup() {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let resources = OSAllocatedUnfairLock(initialState: 0)
        let setup: @MainActor @Sendable () -> Void = { resources.withLock { $0 += 1 } }
        let teardown: @MainActor @Sendable () -> Void = { resources.withLock { $0 -= 1 } }
        lifecycle.start(setup: setup, teardown: teardown)
        executor.runAll()
        lifecycle.stop()
        lifecycle.start(setup: setup, teardown: teardown)
        executor.runLast()
        XCTAssertEqual(resources.withLock { $0 }, 1, "restart cleans old resources even before queued teardown")
        executor.runAll()
        XCTAssertEqual(resources.withLock { $0 }, 1, "stale teardown must preserve new resources")
        lifecycle.stop()
        executor.runAll()
        XCTAssertEqual(resources.withLock { $0 }, 0)
    }

    @MainActor
    func testShutdownDuringRestartCleanupDropsNewSetup() {
        let executor = FakeMainThreadExecutor()
        let lifecycle = MainThreadLifecycle(executor: executor)
        let setups = OSAllocatedUnfairLock(initialState: 0)
        lifecycle.start(setup: { setups.withLock { $0 += 1 } }, teardown: { lifecycle.stop() })
        executor.runAll()
        lifecycle.stop()
        lifecycle.start(setup: { setups.withLock { $0 += 1 } }, teardown: {})
        executor.runLast()
        executor.runAll()
        XCTAssertEqual(setups.withLock { $0 }, 1)
        XCTAssertFalse(lifecycle.isInstalled)
    }

    @MainActor
    func testSdkBackgroundInitializeAndShutdownDropDeferredSetup() {
        let executor = FakeMainThreadExecutor()
        let sdk = AutoMobileSDK.makeTestInstance(
            executor: executor, persistence: FakeEventPersistence(), timerFactory: { FakeTimer() }
        )
        AutoMobileOsEvents.shared.reset()
        let configuration = AutoMobileConfiguration(
            enableCrashReporting: false,
            enableNetworkCapture: false,
            enableHangDetection: false
        )
        sdk.initialize(bundleId: "deferred.sdk", configuration: configuration)
        XCTAssertTrue(sdk.isInitialized)
        XCTAssertEqual(executor.pendingCount, 1)
        XCTAssertFalse(sdk.isMainThreadSetupInstalled)
        sdk.shutdown()
        XCTAssertFalse(sdk.isInitialized)
        XCTAssertEqual(executor.pendingCount, 2)
        executor.runNext()
        XCTAssertFalse(sdk.isMainThreadSetupInstalled, "stale setup is dropped before teardown runs")
        XCTAssertFalse(AutoMobileOsEvents.shared.isTracking)
        executor.runAll()
        XCTAssertFalse(sdk.isMainThreadSetupInstalled)
        XCTAssertFalse(AutoMobileOsEvents.shared.isTracking)
        XCTAssertEqual(AutoMobileOsEvents.shared.observerCount, 0)
    }

    @MainActor
    func testOsEventsBackgroundInitializeAndShutdownDropDeferredObservers() {
        let executor = FakeMainThreadExecutor()
        let osEvents = AutoMobileOsEvents.makeTestInstance(executor: executor)
        let buffer = SdkEventBuffer(timerFactory: { FakeTimer() }, onFlush: { _ in })
        osEvents.initialize(bundleId: "deferred.os", buffer: buffer)
        XCTAssertEqual(executor.pendingCount, 1)
        XCTAssertFalse(osEvents.isTracking)
        osEvents.shutdown()
        XCTAssertEqual(executor.pendingCount, 2)
        executor.runNext()
        XCTAssertFalse(osEvents.isTracking, "stale setup cannot install any resources")
        executor.runAll()
        XCTAssertFalse(osEvents.isTracking)
        XCTAssertEqual(osEvents.observerCount, 0)
    }
}
