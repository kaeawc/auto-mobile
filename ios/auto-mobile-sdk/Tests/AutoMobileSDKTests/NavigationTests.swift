import XCTest
@testable import AutoMobileSDK

final class NavigationEventTests: XCTestCase {
    func testNavigationEventDefaultValues() {
        let event = NavigationEvent(destination: "Home", source: .swiftUINavigation)
        XCTAssertEqual(event.destination, "Home")
        XCTAssertEqual(event.source, .swiftUINavigation)
        XCTAssertTrue(event.arguments.isEmpty)
        XCTAssertTrue(event.metadata.isEmpty)
        XCTAssertGreaterThan(event.timestamp, 0)
    }

    func testNavigationEventWithArguments() {
        let event = NavigationEvent(
            destination: "Detail",
            source: .deepLink,
            arguments: ["id": "123"],
            metadata: ["referrer": "push"]
        )
        XCTAssertEqual(event.arguments["id"], "123")
        XCTAssertEqual(event.metadata["referrer"], "push")
    }
}

final class NavigationSourceTests: XCTestCase {
    func testAllCasesExist() {
        let cases = NavigationSource.allCases
        XCTAssertTrue(cases.contains(.swiftUINavigation))
        XCTAssertTrue(cases.contains(.uiKitNavigation))
        XCTAssertTrue(cases.contains(.deepLink))
        XCTAssertTrue(cases.contains(.custom))
    }

    func testRawValues() {
        XCTAssertEqual(NavigationSource.swiftUINavigation.rawValue, "swiftui_navigation")
        XCTAssertEqual(NavigationSource.uiKitNavigation.rawValue, "uikit_navigation")
        XCTAssertEqual(NavigationSource.deepLink.rawValue, "deep_link")
        XCTAssertEqual(NavigationSource.custom.rawValue, "custom")
    }
}

private final class NavEventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [NavigationEvent] = []
    var events: [NavigationEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func append(_ event: NavigationEvent) { lock.lock(); _events.append(event); lock.unlock() }
}

final class NavigationListenerTests: XCTestCase {
    func testBlockNavigationListenerReceivesEvents() {
        let collector = NavEventCollector()
        let listener = BlockNavigationListener { event in
            collector.append(event)
        }

        let event = NavigationEvent(destination: "Test", source: .custom)
        listener.onNavigationEvent(event)

        XCTAssertEqual(collector.events.count, 1)
        XCTAssertEqual(collector.events.first?.destination, "Test")
    }
}

final class SwiftUINavigationAdapterTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
    }

    override func tearDown() {
        SwiftUINavigationAdapter.shared.stop()
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }

    func testStartAndStop() {
        XCTAssertTrue(SwiftUINavigationAdapter.shared.isActive) // initialized by SDK
        SwiftUINavigationAdapter.shared.stop()
        XCTAssertFalse(SwiftUINavigationAdapter.shared.isActive)
        SwiftUINavigationAdapter.shared.start()
        XCTAssertTrue(SwiftUINavigationAdapter.shared.isActive)
    }

    func testTrackNavigationNotifiesListeners() {
        let listener = FakeNavigationListener()
        AutoMobileSDK.shared.addNavigationListener(listener)

        SwiftUINavigationAdapter.shared.trackNavigation(
            destination: "Settings",
            arguments: ["section": "account"]
        )

        XCTAssertEqual(listener.events.count, 1)
        XCTAssertEqual(listener.events.first?.destination, "Settings")
        XCTAssertEqual(listener.events.first?.source, .swiftUINavigation)
    }

    func testTrackNavigationIgnoredWhenInactive() {
        let listener = FakeNavigationListener()
        AutoMobileSDK.shared.addNavigationListener(listener)
        SwiftUINavigationAdapter.shared.stop()

        SwiftUINavigationAdapter.shared.trackNavigation(destination: "Settings")

        XCTAssertEqual(listener.events.count, 0)
    }
}
