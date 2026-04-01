import XCTest
@testable import AutoMobileSDK

private final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    var events: [any SdkEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func collect(_ events: [any SdkEvent]) { lock.lock(); _events = events; lock.unlock() }
}

private final class FlushCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return _count }
    func increment() { lock.lock(); _count += 1; lock.unlock() }
}

final class SdkEventBufferTests: XCTestCase {
    func testFlushOnCapacity() {
        let expectation = XCTestExpectation(description: "flush called")
        let collector = EventCollector()

        let buffer = SdkEventBuffer(maxBufferSize: 3, flushIntervalMs: 60000) { events in
            collector.collect(events)
            expectation.fulfill()
        }

        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))
        XCTAssertTrue(collector.events.isEmpty)

        buffer.add(SdkCustomEvent(name: "e3"))
        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(collector.events.count, 3)
    }

    func testFlushOnTimer() {
        let expectation = XCTestExpectation(description: "timer flush")
        let collector = EventCollector()

        let fakeTimer = FakeTimer()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 500,
            timerFactory: { fakeTimer }
        ) { events in
            collector.collect(events)
            expectation.fulfill()
        }

        buffer.start()
        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))

        // Manually fire the timer
        fakeTimer.fire()
        wait(for: [expectation], timeout: 1.0)

        XCTAssertEqual(collector.events.count, 2)
    }

    func testShutdownFlushesRemaining() {
        let collector = EventCollector()

        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { events in
            collector.collect(events)
        }

        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))
        buffer.shutdown()

        XCTAssertEqual(collector.events.count, 2)
    }

    func testEmptyFlushDoesNothing() {
        let counter = FlushCounter()

        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { _ in
            counter.increment()
        }

        buffer.flush()
        XCTAssertEqual(counter.count, 0)
    }

    func testTimerScheduledOnStart() {
        let fakeTimer = FakeTimer()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 500,
            timerFactory: { fakeTimer }
        ) { _ in }

        buffer.start()
        XCTAssertEqual(fakeTimer.intervalMs, 500)
        XCTAssertFalse(fakeTimer.isCancelled)

        buffer.shutdown()
        XCTAssertTrue(fakeTimer.isCancelled)
    }
}
