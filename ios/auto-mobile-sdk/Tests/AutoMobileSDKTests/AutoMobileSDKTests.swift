import XCTest
@testable import AutoMobileSDK

private final class NavEventHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _event: NavigationEvent?
    var event: NavigationEvent? { lock.lock(); defer { lock.unlock() }; return _event }
    func set(_ event: NavigationEvent) { lock.lock(); _event = event; lock.unlock() }
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
}
