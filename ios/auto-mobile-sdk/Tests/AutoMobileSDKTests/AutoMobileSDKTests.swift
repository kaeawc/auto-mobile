import XCTest
@testable import AutoMobileSDK

private final class NavEventHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _event: NavigationEvent?
    var event: NavigationEvent? { lock.lock(); defer { lock.unlock() }; return _event }
    func set(_ event: NavigationEvent) { lock.lock(); _event = event; lock.unlock() }
}

private final class LifecycleStateHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _state: String?
    var state: String? { lock.lock(); defer { lock.unlock() }; return _state }
    func set(_ state: String) { lock.lock(); _state = state; lock.unlock() }
}

final class AutoMobileSDKTests: XCTestCase {
    override func tearDown() {
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }

    func testInitializeSetsInitializedFlag() {
        XCTAssertFalse(AutoMobileSDK.shared.isInitialized)
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        XCTAssertTrue(AutoMobileSDK.shared.isInitialized)
    }

    func testInitializeOnlyOnce() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.first")
        AutoMobileSDK.shared.initialize(bundleId: "com.test.second")
        XCTAssertEqual(AutoMobileSDK.shared.bundleId, "com.test.first")
    }

    func testAddAndRemoveNavigationListener() {
        let listener = FakeNavigationListener()
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")

        AutoMobileSDK.shared.addNavigationListener(listener)
        XCTAssertEqual(AutoMobileSDK.shared.listenerCount, 1)

        AutoMobileSDK.shared.removeNavigationListener(listener)
        XCTAssertEqual(AutoMobileSDK.shared.listenerCount, 0)
    }

    func testNotifyNavigationEventCallsListeners() {
        let listener = FakeNavigationListener()
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        AutoMobileSDK.shared.addNavigationListener(listener)

        let event = NavigationEvent(
            destination: "HomeScreen",
            source: .swiftUINavigation,
            arguments: ["tab": "discover"]
        )
        AutoMobileSDK.shared.notifyNavigationEvent(event)

        XCTAssertEqual(listener.events.count, 1)
        XCTAssertEqual(listener.events.first?.destination, "HomeScreen")
        XCTAssertEqual(listener.events.first?.source, .swiftUINavigation)
        XCTAssertEqual(listener.events.first?.arguments["tab"], "discover")
    }

    func testNotifyNavigationEventWhenDisabled() {
        let listener = FakeNavigationListener()
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        AutoMobileSDK.shared.addNavigationListener(listener)
        AutoMobileSDK.shared.setEnabled(false)

        let event = NavigationEvent(destination: "Settings", source: .custom)
        AutoMobileSDK.shared.notifyNavigationEvent(event)

        XCTAssertEqual(listener.events.count, 0)
    }

    func testClearNavigationListeners() {
        let listener1 = FakeNavigationListener()
        let listener2 = FakeNavigationListener()
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")

        AutoMobileSDK.shared.addNavigationListener(listener1)
        AutoMobileSDK.shared.addNavigationListener(listener2)
        XCTAssertEqual(AutoMobileSDK.shared.listenerCount, 2)

        AutoMobileSDK.shared.clearNavigationListeners()
        XCTAssertEqual(AutoMobileSDK.shared.listenerCount, 0)
    }

    func testClosureBasedListener() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        let holder = NavEventHolder()

        AutoMobileSDK.shared.addNavigationListener { event in
            holder.set(event)
        }

        let event = NavigationEvent(destination: "Profile", source: .deepLink)
        AutoMobileSDK.shared.notifyNavigationEvent(event)

        XCTAssertEqual(holder.event?.destination, "Profile")
    }

    func testSetEnabledToggle() {
        XCTAssertTrue(AutoMobileSDK.shared.isEnabled)
        AutoMobileSDK.shared.setEnabled(false)
        XCTAssertFalse(AutoMobileSDK.shared.isEnabled)
        AutoMobileSDK.shared.setEnabled(true)
        XCTAssertTrue(AutoMobileSDK.shared.isEnabled)
    }

    func testSetEnabledBroadcastsTrackingDisabledControlEvent() {
        let holder = LifecycleStateHolder()
        let observer = NotificationCenter.default.addObserver(
            forName: SdkEventBroadcaster.eventBatchNotification,
            object: nil,
            queue: nil
        ) { notification in
            guard let data = notification.userInfo?[SdkEventBroadcaster.eventBatchUserInfoKey] as? Data,
                  let batch = try? JSONDecoder().decode(SdkEventBatch.self, from: data),
                  let event = batch.events.first,
                  let lifecycle = try? JSONDecoder().decode(SdkLifecycleEvent.self, from: event.payload),
                  lifecycle.state == "sdk_tracking_disabled"
            else { return }
            holder.set(lifecycle.state)
        }

        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        AutoMobileSDK.shared.setEnabled(false)

        NotificationCenter.default.removeObserver(observer)
        XCTAssertEqual(holder.state, "sdk_tracking_disabled")
    }
}
