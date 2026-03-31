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

    func testFlushErrorCounted() {
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
        buffer.flush()

        XCTAssertEqual(dropCounter.snapshot()[.flushError], 1)
    }

    func testShutdownFlushErrorCounted() {
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
        buffer.shutdown()

        XCTAssertEqual(dropCounter.snapshot()[.flushError], 1)
    }
}
