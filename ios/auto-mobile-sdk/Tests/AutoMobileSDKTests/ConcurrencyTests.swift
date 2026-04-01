import XCTest
@testable import AutoMobileSDK

private final class EventAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    var events: [any SdkEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func append(_ events: [any SdkEvent]) { lock.lock(); _events.append(contentsOf: events); lock.unlock() }
}

final class ConcurrencyTests: XCTestCase {
    func testConcurrentEventBufferAccess() {
        let expectation = self.expectation(description: "concurrent access")
        expectation.expectedFulfillmentCount = 10

        let accumulator = EventAccumulator()
        let buffer = SdkEventBuffer { events in
            accumulator.append(events)
        }
        buffer.start()

        let queue = DispatchQueue(label: "test.concurrent", attributes: .concurrent)
        for i in 0..<10 {
            queue.async {
                let event = SdkCustomEvent(name: "event_\(i)")
                buffer.add(event)
                expectation.fulfill()
            }
        }

        waitForExpectations(timeout: 2)
        buffer.flush()
        buffer.shutdown()

        XCTAssertEqual(accumulator.events.count, 10)
    }

    func testConcurrentNavigationListenerAccess() {
        let sdk = AutoMobileSDK.shared
        sdk.initialize(bundleId: "test.concurrent")

        let expectation = self.expectation(description: "concurrent listeners")
        expectation.expectedFulfillmentCount = 20

        let queue = DispatchQueue(label: "test.concurrent", attributes: .concurrent)

        // Add and remove listeners concurrently
        for i in 0..<10 {
            queue.async {
                let listener = FakeNavigationListener()
                sdk.addNavigationListener(listener)
                expectation.fulfill()

                // Also fire events concurrently
                sdk.notifyNavigationEvent(NavigationEvent(
                    destination: "screen_\(i)",
                    source: .custom
                ))
                expectation.fulfill()
            }
        }

        waitForExpectations(timeout: 2)
        sdk.reset()
    }

    func testConcurrentInteractionTracking() {
        let expectation = self.expectation(description: "concurrent taps")
        expectation.expectedFulfillmentCount = 10

        let buffer = SdkEventBuffer { _ in }
        buffer.start()
        let tracker = AutoMobileInteractionTracker.shared
        tracker.initialize(bundleId: "test.bundle", buffer: buffer)
        tracker.setEnabled(true)

        let queue = DispatchQueue(label: "test.concurrent", attributes: .concurrent)
        for i in 0..<10 {
            queue.async {
                // Use different timestamps to avoid debounce
                Thread.sleep(forTimeInterval: Double(i) * 0.15)
                tracker.recordTap(x: Double(i * 10), y: Double(i * 20))
                expectation.fulfill()
            }
        }

        waitForExpectations(timeout: 5)
        tracker.reset()
        buffer.shutdown()
    }
}
