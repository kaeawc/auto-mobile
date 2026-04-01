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

// MARK: - Event Processor Tests

final class EventProcessorTests: XCTestCase {
    func testProcessorDropsEventsWithSpecificName() {
        let collector = EventCollector()
        let dropProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkCustomEvent, custom.name == "drop_me" {
                return nil
            }
            return event
        }
        let dropCounter = FakeDropCounter()

        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            processors: [dropProcessor],
            dropCounter: dropCounter
        ) { events in
            collector.collect(events)
        }

        buffer.add(SdkCustomEvent(name: "keep_me"))
        buffer.add(SdkCustomEvent(name: "drop_me"))
        buffer.add(SdkCustomEvent(name: "also_keep"))
        buffer.flush()

        XCTAssertEqual(collector.events.count, 2)
        let names = collector.events.compactMap { ($0 as? SdkCustomEvent)?.name }
        XCTAssertEqual(names, ["keep_me", "also_keep"])
        XCTAssertEqual(dropCounter.snapshot()[.filtered], 1)
    }

    func testProcessorEnrichesEvents() {
        let collector = EventCollector()
        let enrichProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkCustomEvent {
                var props = custom.properties
                props["enriched"] = "true"
                return SdkCustomEvent(
                    timestamp: custom.timestamp,
                    name: custom.name,
                    properties: props
                )
            }
            return event
        }

        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            processors: [enrichProcessor]
        ) { events in
            collector.collect(events)
        }

        buffer.add(SdkCustomEvent(name: "test"))
        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let custom = collector.events.first as? SdkCustomEvent
        XCTAssertEqual(custom?.properties["enriched"], "true")
    }

    func testProcessorChainingEnrichThenFilter() {
        let collector = EventCollector()

        let enrichProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkCustomEvent {
                var props = custom.properties
                props["level"] = "high"
                return SdkCustomEvent(
                    timestamp: custom.timestamp,
                    name: custom.name,
                    properties: props
                )
            }
            return event
        }

        let filterProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkCustomEvent, custom.name == "secret" {
                return nil
            }
            return event
        }

        let dropCounter = FakeDropCounter()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            processors: [enrichProcessor, filterProcessor],
            dropCounter: dropCounter
        ) { events in
            collector.collect(events)
        }

        buffer.add(SdkCustomEvent(name: "visible"))
        buffer.add(SdkCustomEvent(name: "secret"))
        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let custom = collector.events.first as? SdkCustomEvent
        XCTAssertEqual(custom?.name, "visible")
        XCTAssertEqual(custom?.properties["level"], "high")
        XCTAssertEqual(dropCounter.snapshot()[.filtered], 1)
    }

    func testBufferOverflowDropsOldestEvent() {
        let collector = EventCollector()
        let dropCounter = FakeDropCounter()

        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            maxPendingEvents: 3,
            dropCounter: dropCounter
        ) { events in
            collector.collect(events)
        }

        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))
        buffer.add(SdkCustomEvent(name: "e3"))
        // Buffer is now full (3/3). Next add should drop oldest.
        buffer.add(SdkCustomEvent(name: "e4"))
        buffer.add(SdkCustomEvent(name: "e5"))
        buffer.flush()

        let names = collector.events.compactMap { ($0 as? SdkCustomEvent)?.name }
        XCTAssertEqual(names, ["e3", "e4", "e5"])
        XCTAssertEqual(dropCounter.snapshot()[.bufferOverflow], 2)
    }
}
