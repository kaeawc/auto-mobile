import XCTest
@testable import AutoMobileSDK

// The register-vs-shutdown races these managers had are now closed by construction:
// observers/path-monitor are registered WHILE the lock is held (see `initialize`), so a
// `shutdown()` (which also locks) can never interleave between building a resource and
// storing it. There is therefore no injectable mid-registration seam to drive a race
// deterministically; these tests pin the observable init/shutdown lifecycle instead.

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

    /// After initialize+shutdown the observer set is empty regardless of platform — the
    /// atomically-registered observers are all removed on teardown.
    func testInitializeThenShutdownLeavesNoObservers() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let osEvents = AutoMobileOsEvents.shared
        osEvents.reset()

        osEvents.initialize(bundleId: "test.bundle", buffer: buffer)
        osEvents.reset()
        XCTAssertEqual(osEvents.observerCount, 0, "shutdown removes all observers registered under the lock")
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

    /// `initialize` registers its observers atomically under the lock, so they are present
    /// immediately after it returns; `shutdown` removes them all.
    func testInitializeRegistersObserversAndShutdownClearsThem() {
        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let observerTracker = AutoMobileNotificationObserver.shared
        observerTracker.reset()

        observerTracker.initialize(bundleId: "test.bundle", buffer: buffer)
        XCTAssertGreaterThan(observerTracker.observerCount, 0, "initialize registers observers under the lock")

        observerTracker.reset()
        XCTAssertEqual(observerTracker.observerCount, 0, "shutdown removes all observers")
        buffer.shutdown()
    }
}
