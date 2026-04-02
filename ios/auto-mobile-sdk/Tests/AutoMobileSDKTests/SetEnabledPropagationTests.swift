import XCTest
@testable import AutoMobileSDK

/// Thread-safe collector for events flushed by SdkEventBuffer, avoiding
/// `mutation of captured var in concurrently-executing code` errors.
private final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []

    var events: [any SdkEvent] {
        lock.lock()
        defer { lock.unlock() }
        return _events
    }

    func append(_ newEvents: [any SdkEvent]) {
        lock.lock()
        _events.append(contentsOf: newEvents)
        lock.unlock()
    }
}

final class SetEnabledPropagationTests: XCTestCase {
    override func tearDown() {
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }

    // MARK: - Hang Detection

    func testSetEnabledFalseStopsHangMonitoring() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        XCTAssertTrue(AutoMobileHangs.shared.isMonitoring)

        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileHangs.shared.isMonitoring)
    }

    func testSetEnabledTrueRestartsHangMonitoring() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileHangs.shared.isMonitoring)

        AutoMobileSDK.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileHangs.shared.isMonitoring)
    }

    // MARK: - OS Events

    func testSetEnabledFalseDisablesOsEvents() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        XCTAssertTrue(AutoMobileOsEvents.shared.isEnabled)

        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileOsEvents.shared.isEnabled)
    }

    func testSetEnabledTrueReenablesOsEvents() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        AutoMobileSDK.shared.setEnabled(false)
        AutoMobileSDK.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileOsEvents.shared.isEnabled)
    }

    func testOsEventsDoesNotPostWhenDisabled() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer { events in
            collector.append(events)
        }
        buffer.start()
        AutoMobileOsEvents.shared.initialize(bundleId: "test.osevents", buffer: buffer)

        AutoMobileOsEvents.shared.setEnabled(false)

        // Post a notification that OsEvents normally tracks
        NotificationCenter.default.post(
            name: NSLocale.currentLocaleDidChangeNotification,
            object: nil
        )

        buffer.flush()

        let lifecycleEvents = collector.events.compactMap { $0 as? SdkLifecycleEvent }
        XCTAssertTrue(lifecycleEvents.isEmpty, "No lifecycle events should be recorded when OsEvents is disabled")

        AutoMobileOsEvents.shared.reset()
        buffer.shutdown()
    }

    // MARK: - Notification Observer

    func testSetEnabledFalseDisablesNotificationObserver() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        XCTAssertTrue(AutoMobileNotificationObserver.shared.isEnabled)

        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileNotificationObserver.shared.isEnabled)
    }

    func testSetEnabledTrueReenablesNotificationObserver() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        AutoMobileSDK.shared.setEnabled(false)
        AutoMobileSDK.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileNotificationObserver.shared.isEnabled)
    }

    // MARK: - Interaction Tracker

    func testSetEnabledFalseDisablesInteractionTracker() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        // InteractionTracker defaults to false, enable it first
        AutoMobileInteractionTracker.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileInteractionTracker.shared.isEnabled)

        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileInteractionTracker.shared.isEnabled)
    }

    func testInteractionTrackerDoesNotRecordWhenSdkDisabled() {
        let collector = EventCollector()
        let buffer = SdkEventBuffer { events in
            collector.append(events)
        }
        buffer.start()
        let tracker = AutoMobileInteractionTracker.shared
        tracker.initialize(bundleId: "test.interaction", buffer: buffer)
        tracker.setEnabled(true)

        // Disable via SDK propagation
        AutoMobileSDK.shared.setEnabled(false)

        tracker.recordTap(x: 100, y: 200)
        buffer.flush()

        let tapEvents = collector.events.compactMap { $0 as? SdkInteractionEvent }
        XCTAssertTrue(tapEvents.isEmpty, "No tap events should be recorded when SDK is disabled")

        tracker.reset()
        buffer.shutdown()
    }

    // MARK: - Network

    func testSetEnabledFalseDisablesNetwork() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        XCTAssertTrue(AutoMobileNetwork.shared.isEnabled)

        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileNetwork.shared.isEnabled)
    }

    func testSetEnabledTrueReenablesNetwork() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")
        AutoMobileSDK.shared.setEnabled(false)
        AutoMobileSDK.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileNetwork.shared.isEnabled)
    }

    // MARK: - Full Round-Trip

    func testDisableAndReenableAllSubsystems() {
        AutoMobileSDK.shared.initialize(bundleId: "test.setEnabled")

        // Verify initial state
        XCTAssertTrue(AutoMobileHangs.shared.isMonitoring)
        XCTAssertTrue(AutoMobileOsEvents.shared.isEnabled)
        XCTAssertTrue(AutoMobileNotificationObserver.shared.isEnabled)
        XCTAssertTrue(AutoMobileNetwork.shared.isEnabled)

        // Disable everything
        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileHangs.shared.isMonitoring)
        XCTAssertFalse(AutoMobileOsEvents.shared.isEnabled)
        XCTAssertFalse(AutoMobileNotificationObserver.shared.isEnabled)
        XCTAssertFalse(AutoMobileNetwork.shared.isEnabled)
        XCTAssertFalse(AutoMobileSDK.shared.isEnabled)

        // Re-enable everything
        AutoMobileSDK.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileHangs.shared.isMonitoring)
        XCTAssertTrue(AutoMobileOsEvents.shared.isEnabled)
        XCTAssertTrue(AutoMobileNotificationObserver.shared.isEnabled)
        XCTAssertTrue(AutoMobileNetwork.shared.isEnabled)
        XCTAssertTrue(AutoMobileSDK.shared.isEnabled)
    }
}
