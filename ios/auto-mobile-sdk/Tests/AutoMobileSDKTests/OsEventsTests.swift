@testable import AutoMobileSDK
import os
import XCTest
#if canImport(UIKit) && !os(watchOS)
    import UIKit
#endif

// Resource registration is atomic under the manager lock. MainThreadLifecycleTests
// also exercise deferred registration and shutdown invalidation through a fake executor.

final class OsEventsTests: XCTestCase {
    #if canImport(UIKit) && !os(watchOS)
        @MainActor
        func testBrightnessNotificationRecordsSynchronouslyOnMain() throws {
            let osEvents = AutoMobileOsEvents.shared
            osEvents.reset()
            let receivedEvents = OSAllocatedUnfairLock<[SdkLifecycleEvent]>(initialState: [])
            let buffer = SdkEventBuffer(timerFactory: { FakeTimer() }, onFlush: { batch in
                receivedEvents.withLock { $0 += batch.compactMap { $0 as? SdkLifecycleEvent } }
            })
            osEvents.initialize(bundleId: "test.bundle", buffer: buffer)
            defer {
                osEvents.reset()
                buffer.shutdown()
            }

            NotificationCenter.default.post(name: UIScreen.brightnessDidChangeNotification, object: nil)
            buffer.flush()

            let events = receivedEvents.withLock { $0 }
                .filter { $0.state == "screen_brightness_change" }
            XCTAssertEqual(events.count, 1)
            let event = try XCTUnwrap(events.first)
            XCTAssertEqual(event.details["brightness"], "\(Int(UIScreen.main.brightness * 100))")

            osEvents.setEnabled(false)
            NotificationCenter.default.post(name: UIScreen.brightnessDidChangeNotification, object: nil)
            buffer.flush()
            XCTAssertEqual(
                receivedEvents.withLock { $0 }
                    .filter { $0.state == "screen_brightness_change" }.count,
                1
            )
        }
    #endif

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
