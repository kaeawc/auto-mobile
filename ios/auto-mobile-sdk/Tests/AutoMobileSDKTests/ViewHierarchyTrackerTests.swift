#if canImport(UIKit) && !os(watchOS)
import XCTest
@testable import AutoMobileSDK

final class ViewHierarchyTrackerTests: XCTestCase {

    override func tearDown() {
        ViewHierarchyTracker.shared.reset()
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }

    func testInitiallyNoLatestHierarchy() {
        XCTAssertNil(ViewHierarchyTracker.shared.getLatestHierarchy())
    }

    func testInitializeCreatesTimer() {
        let fakeTimer = FakeTimer()
        let fakeBuffer = FakeEventBuffer()

        ViewHierarchyTracker.shared.initialize(buffer: fakeBuffer, timerFactory: { fakeTimer })

        XCTAssertEqual(fakeTimer.intervalMs, 1000)
        XCTAssertFalse(fakeTimer.isCancelled)
    }

    func testResetCancelsTimer() {
        let fakeTimer = FakeTimer()
        let fakeBuffer = FakeEventBuffer()

        ViewHierarchyTracker.shared.initialize(buffer: fakeBuffer, timerFactory: { fakeTimer })
        ViewHierarchyTracker.shared.reset()

        XCTAssertTrue(fakeTimer.isCancelled)
    }

    func testResetClearsLatestHierarchy() {
        let fakeTimer = FakeTimer()
        let fakeBuffer = FakeEventBuffer()

        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        ViewHierarchyTracker.shared.initialize(buffer: fakeBuffer, timerFactory: { fakeTimer })
        ViewHierarchyTracker.shared.reset()

        XCTAssertNil(ViewHierarchyTracker.shared.getLatestHierarchy())
    }

    func testDoubleResetIsSafe() {
        let fakeTimer = FakeTimer()
        let fakeBuffer = FakeEventBuffer()

        ViewHierarchyTracker.shared.initialize(buffer: fakeBuffer, timerFactory: { fakeTimer })
        ViewHierarchyTracker.shared.reset()
        ViewHierarchyTracker.shared.reset()

        XCTAssertTrue(fakeTimer.isCancelled)
    }

    func testPollDoesNotFireWhenSdkDisabled() {
        let fakeTimer = FakeTimer()
        let fakeBuffer = FakeEventBuffer()

        // Don't initialize SDK — isEnabled will be true by default but isInitialized false
        ViewHierarchyTracker.shared.initialize(buffer: fakeBuffer, timerFactory: { fakeTimer })

        // Disable SDK
        AutoMobileSDK.shared.setEnabled(false)

        // Fire timer — should be a no-op since SDK is disabled
        fakeTimer.fire()

        // Give main queue time to process (poll dispatches to main)
        let expectation = expectation(description: "main queue drain")
        DispatchQueue.main.async { expectation.fulfill() }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertTrue(fakeBuffer.events.isEmpty)
    }

    func testWalkNowReturnsHierarchy() {
        let fakeTimer = FakeTimer()
        let fakeBuffer = FakeEventBuffer()

        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        ViewHierarchyTracker.shared.initialize(buffer: fakeBuffer, timerFactory: { fakeTimer })

        let hierarchy = ViewHierarchyTracker.shared.walkNow()

        XCTAssertEqual(hierarchy.bundleId, "com.test.app")
        XCTAssertNotNil(ViewHierarchyTracker.shared.getLatestHierarchy())
    }

    func testHashChangesWhenSafeAreaOrScreenMetricsChange() {
        let baseline = SdkViewHierarchy(
            screenScale: 3,
            screenWidth: 390,
            screenHeight: 844,
            safeAreaInsets: SdkEdgeInsets(top: 59, right: 0, bottom: 34, left: 0),
            root: nil
        )
        let changedInsets = SdkViewHierarchy(
            screenScale: 3,
            screenWidth: 390,
            screenHeight: 844,
            safeAreaInsets: SdkEdgeInsets(top: 59, right: 0, bottom: 34, left: 20),
            root: nil
        )
        let changedDimensions = SdkViewHierarchy(
            screenScale: 3,
            screenWidth: 844,
            screenHeight: 390,
            safeAreaInsets: SdkEdgeInsets(top: 0, right: 59, bottom: 21, left: 34),
            root: nil
        )

        XCTAssertNotEqual(ViewHierarchyWalker.computeHash(baseline), ViewHierarchyWalker.computeHash(changedInsets))
        XCTAssertNotEqual(ViewHierarchyWalker.computeHash(baseline), ViewHierarchyWalker.computeHash(changedDimensions))
    }

    func testHashChangesWhenSystemChromeVisibilityChanges() {
        let baseline = SdkViewHierarchy(
            screenScale: 3,
            screenWidth: 390,
            screenHeight: 844,
            systemChrome: SdkSystemChrome(
                visibility: "visible",
                statusBar: "visible",
                homeIndicatorAutoHideRequested: false,
                source: "ios-status-bar-manager"
            ),
            root: nil
        )
        let hiddenChrome = SdkViewHierarchy(
            screenScale: 3,
            screenWidth: 390,
            screenHeight: 844,
            systemChrome: SdkSystemChrome(
                visibility: "hidden",
                statusBar: "hidden",
                homeIndicatorAutoHideRequested: true,
                source: "ios-status-bar-manager"
            ),
            root: nil
        )

        XCTAssertNotEqual(ViewHierarchyWalker.computeHash(baseline), ViewHierarchyWalker.computeHash(hiddenChrome))
    }

    func testSystemChromeVisibilityUsesObservedStatusBarRatherThanHomeIndicatorPreference() {
        let visible = ViewHierarchyWalker.systemChrome(
            statusBarHidden: false,
            homeIndicatorAutoHideRequested: true
        )
        let hidden = ViewHierarchyWalker.systemChrome(
            statusBarHidden: true,
            homeIndicatorAutoHideRequested: false
        )

        XCTAssertEqual(visible.visibility, "visible")
        XCTAssertEqual(hidden.visibility, "hidden")
    }
}
#endif
