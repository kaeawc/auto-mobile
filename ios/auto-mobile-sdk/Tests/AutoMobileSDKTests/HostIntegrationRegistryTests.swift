@testable import AutoMobileSDK
import AutoMobileSdkWire
import XCTest

final class HostIntegrationRegistryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AutoMobileNavigation.shared.reset()
    }

    override func tearDown() {
        AutoMobileNavigation.shared.reset()
        super.tearDown()
    }

    func testEveryFamilyRequiresRegistrationAndInitialization() {
        let registry = HostIntegrationRegistry()
        XCTAssertEqual(registry.descriptors(initialized: true).map(\.id), [
            "webview.wkwebview", "navigation.uikit", "navigation.swiftui",
            "navigation.deeplink", "navigation.custom",
        ])
        for result in registry.descriptors(initialized: true) {
            XCTAssertEqual(result.state, .disabled)
            XCTAssertEqual(result.reason, "HOST_OPT_IN")
            XCTAssertEqual(result.faultEnforcement, .notEnforceable)
        }
        for family in HostIntegrationFamily.allCases {
            registry.register(family)
        }
        let active = registry.descriptors(initialized: true)
        XCTAssertTrue(active.allSatisfy { $0.state == .supported && $0.reason == nil })
        XCTAssertTrue(active.allSatisfy { $0.faultEnforcement == .notEnforceable && $0.faultActions?.isEmpty == true })
        for family in HostIntegrationFamily.allCases {
            registry.register(family)
        }
        XCTAssertEqual(registry.descriptors(initialized: true), active)
        for result in registry.descriptors(initialized: false) {
            XCTAssertEqual(result.state, .notInitialized)
            XCTAssertEqual(result.reason, "NOT_INITIALIZED")
        }
        registry.reset()
        XCTAssertTrue(registry.descriptors(initialized: false).allSatisfy { $0.state == .notInitialized })
        XCTAssertTrue(registry.descriptors(initialized: true).allSatisfy { $0.reason == "HOST_OPT_IN" })
    }

    func testFacadeRegistersOnlyRequestedFamiliesAndReturnsSharedAdapters() {
        let navigation = AutoMobileNavigation.shared
        navigation.reset()
        XCTAssertTrue(
            navigation.hostIntegrations.descriptors(initialized: true)
                .allSatisfy { $0.reason == "HOST_OPT_IN" }
        )
        let swiftUI = navigation.registerSwiftUI()
        let deepLinks = navigation.registerDeepLinks()
        let custom = navigation.registerCustomRouter()
        XCTAssertTrue(swiftUI === SwiftUINavigationAdapter.shared)
        XCTAssertTrue(deepLinks === DeepLinkNavigationAdapter.shared)
        XCTAssertTrue(custom === CustomNavigationAdapter.shared)
        #if canImport(UIKit) && !os(watchOS)
            XCTAssertTrue(navigation.registerUIKit() === UIKitNavigationAdapter.shared)
        #endif
        let before = navigation.hostIntegrationCapabilities()
        let registered = navigation.hostIntegrations.descriptors(initialized: true)
        XCTAssertTrue(navigation.registerSwiftUI() === swiftUI)
        XCTAssertTrue(navigation.registerDeepLinks() === deepLinks)
        XCTAssertTrue(navigation.registerCustomRouter() === custom)
        #if canImport(UIKit) && !os(watchOS)
            XCTAssertTrue(navigation.registerUIKit() === UIKitNavigationAdapter.shared)
        #endif
        XCTAssertEqual(navigation.hostIntegrations.descriptors(initialized: true), registered)
        XCTAssertEqual(navigation.hostIntegrationCapabilities(), before)
        let descriptors = navigation.hostIntegrations.descriptors(initialized: true)
        XCTAssertEqual(descriptors.first?.reason, "HOST_OPT_IN")
        for result in descriptors.dropFirst() {
            #if !canImport(UIKit) || os(watchOS)
                if result.id == "navigation.uikit" { continue }
            #endif
            XCTAssertEqual(result.state, .supported)
        }
    }

    func testFacadeIsNotInitializedWithoutSDKStart() {
        AutoMobileSDK.shared.reset()
        _ = AutoMobileNavigation.shared.registerDeepLinks()
        XCTAssertTrue(AutoMobileNavigation.shared.hostIntegrationCapabilities().allSatisfy {
            $0.state == .notInitialized && $0.reason == "NOT_INITIALIZED"
        })
    }

    func testSDKStartDoesNotActivateSwiftUIWithoutRegistration() {
        let broadcaster = SdkEventBroadcaster.shared
        let previousURL = broadcaster.ctrlProxyUrl
        broadcaster.ctrlProxyUrl = nil
        defer { broadcaster.ctrlProxyUrl = previousURL }
        let sdk = AutoMobileSDK.makeTestInstance(
            executor: FakeMainThreadExecutor(), persistence: FakeEventPersistence(), timerFactory: { FakeTimer() }
        )
        let configuration = AutoMobileConfiguration(
            enableCrashReporting: false, enableNetworkCapture: false, enableHangDetection: false
        )
        defer { sdk.shutdown() }
        let navigation = AutoMobileNavigation(sdk: sdk)
        XCTAssertTrue(navigation.hostIntegrationCapabilities().allSatisfy { $0.state == .notInitialized })
        sdk.initialize(bundleId: "host.registration.test", configuration: configuration)
        XCTAssertFalse(SwiftUINavigationAdapter.shared.isActive)
        XCTAssertTrue(navigation.hostIntegrationCapabilities().allSatisfy { $0.reason == "HOST_OPT_IN" })
        _ = navigation.registerSwiftUI()
        _ = navigation.registerDeepLinks()
        _ = navigation.registerCustomRouter()
        #if canImport(UIKit) && !os(watchOS)
            _ = navigation.registerUIKit()
        #endif
        // WebKit installation is checked separately; the registry owns its descriptor.
        navigation.hostIntegrations.register(.wkWebView)
        XCTAssertTrue(SwiftUINavigationAdapter.shared.isActive)
        XCTAssertTrue(navigation.hostIntegrationCapabilities().filter { $0.id != "navigation.uikit" }.allSatisfy {
            $0.state == .supported
        })
        sdk.setEnabled(false)
        XCTAssertTrue(navigation.hostIntegrationCapabilities().allSatisfy { $0.state == .notInitialized })
        sdk.setEnabled(true)
        XCTAssertEqual(navigation.hostIntegrationCapabilities().first?.state, .supported)
        sdk.shutdown()
        XCTAssertTrue(navigation.hostIntegrationCapabilities().allSatisfy { $0.state == .notInitialized })
    }

    func testConcurrentRegistrationPreservesDescriptors() {
        let navigation = AutoMobileNavigation.shared
        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            navigation.registerSwiftUI()
            navigation.registerDeepLinks()
            navigation.registerCustomRouter()
        }
        let descriptors = navigation.hostIntegrations.descriptors(initialized: true)
        XCTAssertTrue(descriptors.suffix(3).allSatisfy { $0.state == .supported })
    }

    func testRegistrationPreservesAnotherOwnersRedactor() {
        struct Redactor: NavigationDataRedacting {
            func redact(_: String) -> String { "redacted" }
        }
        let hub = NavigationAdapterHub.shared
        let listener = FakeNavigationListener()
        AutoMobileSDK.shared.addNavigationListener(listener)
        hub.start(owner: "redactor-test", redactor: Redactor())
        defer {
            hub.start(owner: "redactor-test", redactor: NoOpNavigationRedactor())
            hub.stop(owner: "redactor-test")
            AutoMobileSDK.shared.removeNavigationListener(listener)
        }
        let navigation = AutoMobileNavigation.shared
        _ = navigation.registerDeepLinks()
        _ = navigation.registerCustomRouter()
        _ = navigation.registerSwiftUI()
        _ = navigation.registerDeepLinks()
        DeepLinkNavigationAdapter.shared.record(destination: "secret")
        CustomNavigationAdapter.shared.record(destination: "secret")
        SwiftUINavigationAdapter.shared.trackNavigation(destination: "secret")
        XCTAssertEqual(listener.events.map(\.destination), ["redacted", "redacted", "redacted"])
    }
}
