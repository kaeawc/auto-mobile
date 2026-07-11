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

        buffer.add(SdkInteractionEvent(interactionType: "e1"))
        buffer.add(SdkInteractionEvent(interactionType: "e2"))
        XCTAssertTrue(collector.events.isEmpty)

        buffer.add(SdkInteractionEvent(interactionType: "e3"))
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
        buffer.add(SdkInteractionEvent(interactionType: "e1"))
        buffer.add(SdkInteractionEvent(interactionType: "e2"))

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

        buffer.add(SdkInteractionEvent(interactionType: "e1"))
        buffer.add(SdkInteractionEvent(interactionType: "e2"))
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

    // Regression guard for issue #3605 (and its Android twin #3710): a throw from a
    // *timer-scheduled* flush must not tear down the repeating flush timer. The
    // existing flush-error tests only drive the throw through a direct `flush()` /
    // `shutdown()` call; this one drives it through the timer, then fires the timer
    // again to prove it is still live and still flushing.
    func testTimerSurvivesThrowingFlush() {
        struct FlushError: Error {}
        let fakeTimer = FakeTimer()
        let dropCounter = FakeDropCounter()

        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 500,
            timerFactory: { fakeTimer },
            dropCounter: dropCounter
        ) { _ in
            throw FlushError()
        }

        buffer.start()

        // First scheduled flush throws — must be swallowed and counted, not crash.
        buffer.add(SdkInteractionEvent(interactionType: "e1"))
        buffer.add(SdkInteractionEvent(interactionType: "e2"))
        fakeTimer.fire()
        XCTAssertEqual(dropCounter.snapshot()[.flushError], 2)

        // The throw must not have cancelled the repeating timer (the #3605 bug).
        XCTAssertFalse(fakeTimer.isCancelled)

        // A subsequent tick must still flush — proving the timer kept firing after
        // the earlier throw. Cumulative flushError count reflects both rounds.
        buffer.add(SdkInteractionEvent(interactionType: "e3"))
        buffer.add(SdkInteractionEvent(interactionType: "e4"))
        buffer.add(SdkInteractionEvent(interactionType: "e5"))
        fakeTimer.fire()
        XCTAssertEqual(dropCounter.snapshot()[.flushError], 5)
    }
}

// MARK: - Event Processor Tests

final class EventProcessorTests: XCTestCase {
    func testProcessorDropsEventsWithSpecificName() {
        let collector = EventCollector()
        let dropProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkInteractionEvent, custom.interactionType == "drop_me" {
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

        buffer.add(SdkInteractionEvent(interactionType: "keep_me"))
        buffer.add(SdkInteractionEvent(interactionType: "drop_me"))
        buffer.add(SdkInteractionEvent(interactionType: "also_keep"))
        buffer.flush()

        XCTAssertEqual(collector.events.count, 2)
        let names = collector.events.compactMap { ($0 as? SdkInteractionEvent)?.interactionType }
        XCTAssertEqual(names, ["keep_me", "also_keep"])
        XCTAssertEqual(dropCounter.snapshot()[.filtered], 1)
    }

    func testProcessorEnrichesEvents() {
        let collector = EventCollector()
        let enrichProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkInteractionEvent {
                var props = custom.properties
                props["enriched"] = "true"
                return SdkInteractionEvent(
                    timestamp: custom.timestamp,
                    interactionType: custom.interactionType,
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

        buffer.add(SdkInteractionEvent(interactionType: "test"))
        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let custom = collector.events.first as? SdkInteractionEvent
        XCTAssertEqual(custom?.properties["enriched"], "true")
    }

    func testProcessorChainingEnrichThenFilter() {
        let collector = EventCollector()

        let enrichProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkInteractionEvent {
                var props = custom.properties
                props["level"] = "high"
                return SdkInteractionEvent(
                    timestamp: custom.timestamp,
                    interactionType: custom.interactionType,
                    properties: props
                )
            }
            return event
        }

        let filterProcessor = FakeEventProcessor { event in
            if let custom = event as? SdkInteractionEvent, custom.interactionType == "secret" {
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

        buffer.add(SdkInteractionEvent(interactionType: "visible"))
        buffer.add(SdkInteractionEvent(interactionType: "secret"))
        buffer.flush()

        XCTAssertEqual(collector.events.count, 1)
        let custom = collector.events.first as? SdkInteractionEvent
        XCTAssertEqual(custom?.interactionType, "visible")
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

        buffer.add(SdkInteractionEvent(interactionType: "e1"))
        buffer.add(SdkInteractionEvent(interactionType: "e2"))
        buffer.add(SdkInteractionEvent(interactionType: "e3"))
        // Buffer is now full (3/3). Next add should drop oldest.
        buffer.add(SdkInteractionEvent(interactionType: "e4"))
        buffer.add(SdkInteractionEvent(interactionType: "e5"))
        buffer.flush()

        let names = collector.events.compactMap { ($0 as? SdkInteractionEvent)?.interactionType }
        XCTAssertEqual(names, ["e3", "e4", "e5"])
        XCTAssertEqual(dropCounter.snapshot()[.bufferOverflow], 2)
    }
}
