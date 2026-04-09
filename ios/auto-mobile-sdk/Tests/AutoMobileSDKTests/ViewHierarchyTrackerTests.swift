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
}
#endif
