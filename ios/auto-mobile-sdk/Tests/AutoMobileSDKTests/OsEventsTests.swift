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

    /// Observers whose registration completes AFTER a `shutdown()` (the
    /// register-vs-shutdown race) must not be stored — they would fire after teardown
    /// and never be removed.
    func testStoreObserversDroppedWhenNotInitialized() {
        let osEvents = AutoMobileOsEvents.shared
        osEvents.reset() // ensure not initialized
        XCTAssertEqual(osEvents.observerCount, 0)

        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("am.test.notinit"), object: nil, queue: nil
        ) { _ in }
        osEvents.storeObservers([observer])

        XCTAssertEqual(osEvents.observerCount, 0, "observers registered while not initialized must be dropped")
    }

    func testStoreObserversKeptWhileInitializedThenClearedOnShutdown() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let osEvents = AutoMobileOsEvents.shared
        osEvents.reset()
        osEvents.initialize(bundleId: "test.bundle", buffer: buffer)

        let before = osEvents.observerCount
        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("am.test.init"), object: nil, queue: nil
        ) { _ in }
        osEvents.storeObservers([observer])
        XCTAssertEqual(osEvents.observerCount, before + 1, "observers registered while initialized are stored")

        osEvents.reset()
        XCTAssertEqual(osEvents.observerCount, 0, "shutdown removes all stored observers")
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

    /// Observers whose registration completes AFTER a `shutdown()` must not be stored.
    func testStoreObserversDroppedWhenNotInitialized() {
        let observerTracker = AutoMobileNotificationObserver.shared
        observerTracker.reset() // ensure not initialized
        XCTAssertEqual(observerTracker.observerCount, 0)

        let observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("am.test.obs.notinit"), object: nil, queue: nil
        ) { _ in }
        observerTracker.storeObservers([observer])

        XCTAssertEqual(observerTracker.observerCount, 0, "observers registered while not initialized must be dropped")
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
