import XCTest
@testable import AutoMobileSDK

final class DefaultAutoMobileAPITests: XCTestCase {
    override func tearDown() {
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }

    func testConformsToProtocol() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        XCTAssertFalse(api.isInitialized)
    }

    func testInitializeDelegatesToSharedSdk() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        XCTAssertFalse(api.isInitialized)
        api.initialize()
        XCTAssertTrue(api.isInitialized)
        XCTAssertTrue(AutoMobileSDK.shared.isInitialized)
    }

    func testInitializeWithConfiguration() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        let config = AutoMobileConfiguration(bufferSize: 7)
        api.initialize(configuration: config)
        XCTAssertEqual(api.configuration?.bufferSize, 7)
    }

    func testSetEnabledDelegates() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        api.initialize()
        XCTAssertTrue(api.isEnabled)
        api.setEnabled(false)
        XCTAssertFalse(api.isEnabled)
        XCTAssertFalse(AutoMobileSDK.shared.isEnabled)
        api.setEnabled(true)
    }

    func testNavigationListenersDelegate() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        api.initialize()

        let listener = FakeNavigationListener()
        api.addNavigationListener(listener)
        XCTAssertEqual(api.listenerCount, 1)
        XCTAssertEqual(AutoMobileSDK.shared.listenerCount, 1)

        let event = NavigationEvent(destination: "Home", source: .custom)
        api.notifyNavigationEvent(event)
        XCTAssertEqual(listener.events.count, 1)

        api.removeNavigationListener(listener)
        XCTAssertEqual(api.listenerCount, 0)
    }

    func testClosureListenerDelegate() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        api.initialize()

        let holder = NavEventHolder()
        _ = api.addNavigationListener { event in
            holder.set(event)
        }
        api.notifyNavigationEvent(NavigationEvent(destination: "Settings", source: .deepLink))
        XCTAssertEqual(holder.event?.destination, "Settings")

        api.clearNavigationListeners()
        XCTAssertEqual(api.listenerCount, 0)
    }

    func testBreadcrumbAndTagDelegate() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        api.initialize()

        api.addBreadcrumb(message: "hello", category: .custom, metadata: ["k": "v"])
        api.setUserId("user-1")
        api.setTag("env", value: "test")
        api.removeTag("env")
        XCTAssertTrue(api.isInitialized)
    }

    func testShutdownDelegates() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        api.initialize()
        XCTAssertTrue(api.isInitialized)
        api.shutdown()
        XCTAssertFalse(api.isInitialized)
        XCTAssertFalse(AutoMobileSDK.shared.isInitialized)
    }

    func testStatusAccessors() {
        let api: AutoMobileAPI = DefaultAutoMobileAPI()
        api.initialize()
        XCTAssertEqual(api.bundleId, AutoMobileSDK.shared.bundleId)
        XCTAssertEqual(api.dropReport.count, AutoMobileSDK.shared.dropReport.count)
        XCTAssertEqual(api.currentSessionId(), AutoMobileSDK.shared.currentSessionId())
    }

    func testNetworkAndCrashesDefaults() {
        let network: AutoMobileNetworkAPI = DefaultAutoMobileNetworkAPI()
        network.setCaptureHeaders(true)
        network.setCaptureBodies(false)

        let crashes: AutoMobileCrashesAPI = DefaultAutoMobileCrashesAPI()
        crashes.setCurrentScreenProvider { "Home" }
        XCTAssertEqual(AutoMobileCrashes.shared.currentScreenProvider?(), "Home")
        crashes.setCurrentScreenProvider(nil)
    }
}

private final class NavEventHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _event: NavigationEvent?
    var event: NavigationEvent? { lock.lock(); defer { lock.unlock() }; return _event }
    func set(_ event: NavigationEvent) { lock.lock(); _event = event; lock.unlock() }
}
