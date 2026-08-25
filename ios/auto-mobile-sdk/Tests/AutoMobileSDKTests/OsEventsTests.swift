import XCTest
@testable import AutoMobileSDK

final class OsEventsTests: XCTestCase {
    func testOsEventsInitializesOnce() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()

        AutoMobileOsEvents.shared.initialize(bundleId: "test.bundle", buffer: buffer)
        // Second call should be a no-op
        AutoMobileOsEvents.shared.initialize(bundleId: "test.bundle", buffer: buffer)

        AutoMobileOsEvents.shared.reset()
        buffer.shutdown()
    }

    func testOsEventsShutdownCleansUp() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()

        AutoMobileOsEvents.shared.initialize(bundleId: "test.bundle", buffer: buffer)
        AutoMobileOsEvents.shared.reset()

        // Should be able to re-initialize after reset
        AutoMobileOsEvents.shared.initialize(bundleId: "test.bundle", buffer: buffer)
        AutoMobileOsEvents.shared.reset()

        buffer.shutdown()
    }

    /// Observers published with the current init generation are stored; a `shutdown()`
    /// then removes them.
    func testStoreObserversKeptForCurrentGenerationThenClearedOnShutdown() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let osEvents = AutoMobileOsEvents.shared
        osEvents.reset()
        osEvents.initialize(bundleId: "test.bundle", buffer: buffer)

        let before = osEvents.observerCount
        let generation = osEvents.initGeneration
        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("am.test.init"), object: nil, queue: nil
        ) { _ in }
        osEvents.storeObservers([observer], generation: generation)
        XCTAssertEqual(osEvents.observerCount, before + 1, "observers published with the current generation are stored")

        osEvents.reset()
        XCTAssertEqual(osEvents.observerCount, 0, "shutdown removes all stored observers")
        buffer.shutdown()
    }

    /// A→shutdown→B→A: an init A that pauses mid-registration, is shut down, and a NEW
    /// init B starts, must NOT have A's late-published observers land in B's session. A
    /// bare `_isInitialized` boolean permits this ABA; the generation token rejects it.
    func testAbaReinitializeDropsStaleInitObservers() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let osEvents = AutoMobileOsEvents.shared
        osEvents.reset()

        osEvents.initialize(bundleId: "A", buffer: buffer) // init A
        let generationA = osEvents.initGeneration
        osEvents.reset() // shutdown
        osEvents.initialize(bundleId: "B", buffer: buffer) // init B — _isInitialized true again
        let countB = osEvents.observerCount

        // A's late publication carries A's (now stale) generation.
        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("am.test.aba"), object: nil, queue: nil
        ) { _ in }
        osEvents.storeObservers([observer], generation: generationA)

        XCTAssertEqual(osEvents.observerCount, countB, "a stale init's observers must not leak into a newer init's session")
        osEvents.reset()
        buffer.shutdown()
    }
}

final class NotificationObserverTests: XCTestCase {
    func testObserverInitializesOnce() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()

        AutoMobileNotificationObserver.shared.initialize(bundleId: "test.bundle", buffer: buffer)
        // Second call should be a no-op
        AutoMobileNotificationObserver.shared.initialize(bundleId: "test.bundle", buffer: buffer)

        AutoMobileNotificationObserver.shared.reset()
        buffer.shutdown()
    }

    func testObserverShutdownCleansUp() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()

        AutoMobileNotificationObserver.shared.initialize(bundleId: "test.bundle", buffer: buffer)
        AutoMobileNotificationObserver.shared.reset()

        // Should be able to re-initialize after reset
        AutoMobileNotificationObserver.shared.initialize(bundleId: "test.bundle", buffer: buffer)
        AutoMobileNotificationObserver.shared.reset()

        buffer.shutdown()
    }

    /// A→shutdown→B→A: A's late-published observers, carrying A's stale generation, must
    /// not overwrite B's observers. A bare `_isInitialized` boolean permits this ABA.
    func testAbaReinitializeDropsStaleInitObservers() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let observerTracker = AutoMobileNotificationObserver.shared
        observerTracker.reset()

        observerTracker.initialize(bundleId: "A", buffer: buffer) // init A
        let generationA = observerTracker.initGeneration
        observerTracker.reset() // shutdown
        observerTracker.initialize(bundleId: "B", buffer: buffer) // init B
        let countB = observerTracker.observerCount
        XCTAssertGreaterThan(countB, 0)

        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("am.test.obs.aba"), object: nil, queue: nil
        ) { _ in }
        observerTracker.storeObservers([observer], generation: generationA)

        XCTAssertEqual(
            observerTracker.observerCount,
            countB,
            "a stale init's observers must not overwrite a newer init's session"
        )
        observerTracker.reset()
        buffer.shutdown()
    }

    func testInitializeRegistersObserversAndShutdownClearsThem() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let observerTracker = AutoMobileNotificationObserver.shared
        observerTracker.reset()

        observerTracker.initialize(bundleId: "test.bundle", buffer: buffer)
        XCTAssertGreaterThan(observerTracker.observerCount, 0, "initialize registers observers")

        observerTracker.reset()
        XCTAssertEqual(observerTracker.observerCount, 0, "shutdown removes all observers")
        buffer.shutdown()
    }
}
