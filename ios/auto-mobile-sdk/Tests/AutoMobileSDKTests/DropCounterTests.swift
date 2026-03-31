import XCTest
@testable import AutoMobileSDK

final class DefaultDropCounterTests: XCTestCase {
    func testIncrementAndSnapshot() {
        let counter = DefaultDropCounter()
        counter.increment(.disabled)
        counter.increment(.disabled)
        counter.increment(.flushError)

        let snap = counter.snapshot()
        XCTAssertEqual(snap[.disabled], 2)
        XCTAssertEqual(snap[.flushError], 1)
        XCTAssertNil(snap[.shutdown])
    }

    func testSnapshotReturnsCopy() {
        let counter = DefaultDropCounter()
        counter.increment(.shutdown)
        let snap1 = counter.snapshot()

        counter.increment(.shutdown)
        let snap2 = counter.snapshot()

        XCTAssertEqual(snap1[.shutdown], 1)
        XCTAssertEqual(snap2[.shutdown], 2)
    }

    func testResetClears() {
        let counter = DefaultDropCounter()
        counter.increment(.disabled)
        counter.increment(.flushError)
        counter.reset()

        let snap = counter.snapshot()
        XCTAssertTrue(snap.isEmpty)
    }

    func testIncrementByCount() {
        let counter = DefaultDropCounter()
        counter.increment(.flushError, count: 5)
        counter.increment(.disabled, count: 3)
        counter.increment(.flushError, count: 2)

        let snap = counter.snapshot()
        XCTAssertEqual(snap[.flushError], 7)
        XCTAssertEqual(snap[.disabled], 3)
    }

    func testConcurrentAccess() {
        let counter = DefaultDropCounter()
        let iterations = 1000

        DispatchQueue.concurrentPerform(iterations: iterations) { _ in
            counter.increment(.disabled)
        }

        XCTAssertEqual(counter.snapshot()[.disabled], iterations)
    }
}

// MARK: - SdkEventBuffer + DropCounter

final class SdkEventBufferDropCounterTests: XCTestCase {
    func testDropCountedWhenDisabled() {
        let dropCounter = FakeDropCounter()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            dropCounter: dropCounter
        ) { _ in }

        buffer.isBufferEnabled = false
        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))

        XCTAssertEqual(dropCounter.snapshot()[.disabled], 2)
    }

    func testNoDropCountWhenEnabled() {
        let dropCounter = FakeDropCounter()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            dropCounter: dropCounter
        ) { _ in }

        buffer.add(SdkCustomEvent(name: "e1"))

        XCTAssertTrue(dropCounter.snapshot().isEmpty)
    }

    func testFlushErrorCountedPerEvent() {
        struct FlushError: Error {}
        let dropCounter = FakeDropCounter()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            dropCounter: dropCounter
        ) { _ in
            throw FlushError()
        }

        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))
        buffer.add(SdkCustomEvent(name: "e3"))
        buffer.flush()

        XCTAssertEqual(dropCounter.snapshot()[.flushError], 3)
    }

    func testShutdownFlushErrorCountedPerEvent() {
        struct FlushError: Error {}
        let dropCounter = FakeDropCounter()
        let buffer = SdkEventBuffer(
            maxBufferSize: 100,
            flushIntervalMs: 60000,
            dropCounter: dropCounter
        ) { _ in
            throw FlushError()
        }

        buffer.add(SdkCustomEvent(name: "e1"))
        buffer.add(SdkCustomEvent(name: "e2"))
        buffer.shutdown()

        XCTAssertEqual(dropCounter.snapshot()[.flushError], 2)
    }
}
