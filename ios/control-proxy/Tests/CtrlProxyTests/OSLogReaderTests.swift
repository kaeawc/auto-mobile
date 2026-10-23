@testable import CtrlProxy
import Foundation
import os
import OSLog
import XCTest

final class OSLogReaderTests: XCTestCase {
    func testDrainDoesNotWaitForPollingQueue() throws {
        let queue = DispatchQueue(label: "test.oslog.poll")
        let reader = OSLogReader(queue: queue, storeFactory: { throw TestError.unused })
        reader.appendCompletedEntries([
            OSLogReader.LogEntry(eventType: "log", timestamp: 1, level: 2, tag: nil, message: "ready"),
        ])
        queue.suspend()
        defer { queue.resume() }
        let drained = expectation(description: "drain completes while polling is blocked")
        DispatchQueue.global().async {
            XCTAssertEqual(reader.drain().count, 1)
            drained.fulfill()
        }
        wait(for: [drained], timeout: 0.05)
        XCTAssertTrue(reader.drain().isEmpty)
    }

    func testBufferKeepsNewestFiveHundredEntries() throws {
        let reader = OSLogReader(storeFactory: { throw TestError.unused })
        reader.appendCompletedEntries((0 ..< 501).map {
            OSLogReader.LogEntry(eventType: "log", timestamp: Int64($0), level: 2, tag: nil, message: "entry")
        })
        struct Batch: Decodable { let events: [Event] }
        struct Event: Decodable { let payload: Data }
        let batch = try JSONDecoder().decode(Batch.self, from: XCTUnwrap(reader.drain().first))
        XCTAssertEqual(batch.events.count, 500)
        let first = try JSONDecoder().decode(OSLogReader.LogEntry.self, from: XCTUnwrap(batch.events.first).payload)
        XCTAssertEqual(first.timestamp, 1)
        XCTAssertTrue(reader.drain().isEmpty)
    }

    func testWakeOnDrain() {
        let harness = Harness()
        harness.reader.start()
        harness.flush()
        XCTAssertTrue(harness.source.queries.isEmpty)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        harness.wake()
        XCTAssertEqual(harness.source.queries.count, 1)
        XCTAssertEqual(harness.scheduler.delays, [1000])
        harness.wake()
        XCTAssertEqual(harness.source.queries.count, 1, "Repeated drains must not duplicate a sequence")
    }

    func testDisarmedDrainDoesNotPoll() {
        let harness = Harness()
        harness.wake()
        harness.reader.start()
        harness.reader.stop()
        harness.wake()
        XCTAssertTrue(harness.source.queries.isEmpty)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
    }

    func testBackoffSequence() {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        for delay in [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000] {
            harness.advance(Int64(delay))
        }
        XCTAssertEqual(harness.scheduler.delays, [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000])
        XCTAssertEqual(harness.source.queries.count, 8)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        XCTAssertEqual(harness.source.resetCount, 1)
        harness.advance(8000)
        XCTAssertEqual(harness.source.queries.count, 8)
    }

    func testEntriesResetBackoff() throws {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        harness.advance(1000)
        harness.source.records = [record(1001, "first"), record(1002, "second", category: "network")]
        harness.advance(2000)
        XCTAssertEqual(harness.scheduler.delays, [1000, 2000, 1000])
        let entries = try decode(harness.reader.drain())
        XCTAssertEqual(entries.map(\.message), ["first", "[network] second"])
        XCTAssertEqual(entries.map(\.timestamp), [1_001_000, 1_002_000])
        XCTAssertEqual(entries.map(\.level), [4, 4])
        XCTAssertEqual(entries.map(\.tag), ["test.app", "test.app"])
        harness.flush()
        harness.source.records = []
        for delay in [1000, 2000, 4000] {
            harness.advance(Int64(delay))
        }
        XCTAssertEqual(harness.scheduler.delays.suffix(3), [2000, 4000, 8000])
        harness.advance(8000)
        XCTAssertEqual(harness.scheduler.pendingCount, 1)
    }

    /// Captured on iOS 27.0 (#15030): each poll and HTTP drain logs its own transport lines.
    /// They must neither reset the backoff nor be published, yet the cursor must pass them.
    func testSelfGeneratedNoiseDoesNotResetBackoffOrPublish() throws {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        harness.source.records = [
            OSLogRecord(
                date: Date(timeIntervalSince1970: 1001), level: 2, subsystem: "com.apple.xpc",
                category: "connection", composedMessage: "[0x1] activating connection: name=com.apple.OSLogService"
            ),
            OSLogRecord(
                date: Date(timeIntervalSince1970: 1002), level: 2, subsystem: "com.apple.network",
                category: "connection",
                composedMessage: "nw_connection_report_state_with_handler_on_nw_queue [C4] reporting state ready"
            ),
        ]
        harness.advance(1000)
        harness.source.records = []
        harness.advance(2000)
        XCTAssertEqual(harness.scheduler.delays, [1000, 2000, 4000])
        XCTAssertTrue(harness.reader.drain().isEmpty)
        harness.flush()
        XCTAssertEqual(harness.source.queries.last, Date(timeIntervalSince1970: 1002))
    }

    func testResumeFromLastSeen() throws {
        let harness = Harness()
        harness.source.records = [record(1001, "first"), record(1002, "second")]
        harness.reader.start()
        harness.wake()
        _ = harness.reader.drain()
        harness.flush()
        harness.source.records = []
        for delay in [1000, 2000, 4000, 8000] {
            harness.advance(Int64(delay))
        }
        harness.advance(30001)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        harness.source.records = [record(1001, "old"), record(1002, "duplicate"), record(1003, "new")]
        harness.wake()
        XCTAssertEqual(harness.source.queries.last, Date(timeIntervalSince1970: 1002))
        XCTAssertEqual(try decode(harness.reader.drain()).map(\.message), ["new"])
    }

    func testLookbackClamp() {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        for delay in [1000, 2000, 4000, 8000] {
            harness.advance(Int64(delay))
        }
        harness.advance(600_000)
        harness.wake()
        XCTAssertEqual(
            harness.source.queries.last,
            Date(timeIntervalSince1970: Double(harness.clock.now() - 120_000) / 1000)
        )
    }

    func testStopCancels() {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        harness.reader.stop()
        XCTAssertEqual(harness.source.resetCount, 1)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        harness.advance(60000)
        XCTAssertEqual(harness.source.queries.count, 1)
        harness.reader.start()
        harness.wake()
        XCTAssertEqual(harness.scheduler.delays, [1000, 1000])
    }

    func testOSLogSourceErrorBacksOffUntilDrainIdle() {
        let harness = Harness()
        harness.source.shouldThrow = true
        harness.reader.start()
        harness.wake()
        for delay in [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000] {
            harness.advance(Int64(delay))
        }
        XCTAssertEqual(harness.scheduler.delays, [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000])
        XCTAssertEqual(harness.source.queries.count, 8)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        XCTAssertEqual(harness.source.resetCount, 1)
    }

    func testNewEntriesDoNotExtendDrainIdleWindow() {
        let harness = Harness()
        harness.source.records = [record(1000.001, "initial")]
        harness.reader.start()
        harness.wake()
        for _ in 0 ..< 45 {
            harness.source.records = [record(Double(harness.clock.now() + 1000) / 1000, "new")]
            harness.advance(1000)
        }
        XCTAssertEqual(harness.source.queries.count, 46, "Demand remains active at exactly 45 seconds")
        XCTAssertEqual(harness.scheduler.pendingCount, 1)
        harness.advance(1000)
        XCTAssertEqual(harness.source.queries.count, 46)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        XCTAssertEqual(harness.source.resetCount, 1)
        harness.advance(60000)
        XCTAssertEqual(harness.source.queries.count, 46)
    }

    func testIdleSessionDiscardsUnconsumedTail() {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        harness.source.records = [record(1001, "stale tail")]
        harness.advance(1000)
        XCTAssertEqual(harness.source.queries.count, 2)
        harness.advance(45001)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        XCTAssertEqual(harness.source.resetCount, 1)
        XCTAssertTrue(harness.reader.drain().isEmpty, "A new consumer must not receive the previous session's tail")
        harness.flush()
        harness.reader.stop()
    }

    func testThirtySecondDrainsKeepBackedOffSessionAlive() {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        for _ in 0 ..< 3 {
            for _ in 0 ..< 30 {
                harness.advance(1000)
            }
            let delaysBeforeDrain = harness.scheduler.delays
            let queriesBeforeDrain = harness.source.queries.count
            harness.wake()
            XCTAssertEqual(harness.source.queries.count, queriesBeforeDrain)
            XCTAssertEqual(harness.scheduler.delays, delaysBeforeDrain, "Active drains must not reset backoff")
            XCTAssertEqual(harness.scheduler.pendingCount, 1)
            XCTAssertEqual(harness.scheduler.delays.last, 8000)
            XCTAssertEqual(harness.source.resetCount, 0)
        }
        XCTAssertEqual(harness.source.queries.count, 14)
        XCTAssertEqual(harness.scheduler.delays, [1000, 2000, 4000] + Array(repeating: 8000, count: 11))
    }

    func testCancelledCallbackCannotPollRestartedSession() throws {
        let harness = Harness()
        harness.reader.start()
        harness.wake()
        let oldCallback = try XCTUnwrap(harness.scheduler.scheduledCallbacks.first)
        harness.reader.stop()
        harness.reader.start()
        harness.wake()
        XCTAssertEqual(harness.source.queries.count, 2)
        oldCallback()
        harness.flush()
        XCTAssertEqual(harness.source.queries.count, 2)
        XCTAssertEqual(harness.scheduler.pendingCount, 1)
        harness.advance(1000)
        XCTAssertEqual(harness.source.queries.count, 3)
    }

    func testIdleWindowExceededDuringQueryReleasesSourceWithoutScheduling() {
        let harness = Harness()
        let clock = harness.clock
        harness.source.onQuery = { clock.advance(by: 45001) }
        harness.source.records = [record(1001, "new")]
        harness.reader.start()
        harness.wake()
        XCTAssertEqual(harness.source.queries.count, 1)
        XCTAssertEqual(harness.scheduler.pendingCount, 0)
        XCTAssertTrue(harness.scheduler.delays.isEmpty)
        XCTAssertEqual(harness.source.resetCount, 1)
        harness.reader.stop()
        XCTAssertEqual(harness.source.resetCount, 2)
    }

    func testMapLevel() {
        let cases: [(OSLogEntryLog.Level, Int)] = [
            (.undefined, 2), (.debug, 1), (.info, 2), (.notice, 2), (.error, 4), (.fault, 5),
        ]
        for (level, expected) in cases {
            XCTAssertEqual(OSLogReader.mapLevel(level), expected)
        }
    }

    private func record(_ seconds: TimeInterval, _ message: String, category: String = "") -> OSLogRecord {
        OSLogRecord(
            date: Date(timeIntervalSince1970: seconds), level: 4,
            subsystem: "test.app", category: category, composedMessage: message
        )
    }

    private func decode(_ batches: [Data]) throws -> [OSLogReader.LogEntry] {
        struct Batch: Decodable { let bundleId: String?; let events: [Event] }
        struct Event: Decodable { let eventType: String; let payload: Data }
        let batch = try JSONDecoder().decode(Batch.self, from: XCTUnwrap(batches.first))
        XCTAssertNil(batch.bundleId)
        return try batch.events.map {
            XCTAssertEqual($0.eventType, "log")
            let entry = try JSONDecoder().decode(OSLogReader.LogEntry.self, from: $0.payload)
            XCTAssertEqual(entry.eventType, "log")
            return entry
        }
    }

    private enum TestError: Error { case unused }
}

private final class Harness {
    let queue = DispatchQueue(label: "test.oslog.demand")
    let clock = FakeProxyTimer(mode: .manual, initialTime: 1_000_000)
    let scheduler = FakeOSLogScheduler()
    let source = FakeOSLogSource()
    let reader: OSLogReader

    init() {
        reader = OSLogReader(queue: queue, source: source, clock: clock, scheduler: scheduler)
    }

    func flush() { queue.sync {} }
    func wake() { _ = reader.drain(); flush() }
    func advance(_ milliseconds: Int64) {
        clock.advance(by: milliseconds)
        scheduler.advance(by: milliseconds)
        flush()
    }
}

// Accessed only on the reader queue, or between explicit queue barriers in tests.
private final class FakeOSLogSource: OSLogEntrySource, @unchecked Sendable {
    var records: [OSLogRecord] = []
    var queries: [Date] = []
    var shouldThrow = false
    var onQuery: (() -> Void)?
    private(set) var resetCount = 0

    func reset() { resetCount += 1 }

    func entries(since date: Date) throws -> [OSLogRecord] {
        queries.append(date)
        onQuery?()
        if shouldThrow { throw Failure.scripted }
        return records
    }

    private enum Failure: Error { case scripted }
}

private final class FakeOSLogScheduler: OSLogPollScheduler, @unchecked Sendable {
    private struct Pending {
        let deadline: Int64
        let token: Token
        let callback: @Sendable () -> Void
    }

    private final class Token: OSLogPollCancellation {
        private let cancelled = OSAllocatedUnfairLock(initialState: false)
        var isCancelled: Bool { cancelled.withLock { $0 } }
        func cancel() { cancelled.withLock { $0 = true } }
    }

    // Scheduling is on the reader queue; tests inspect/advance only after barriers.
    private var time: Int64 = 0
    private var pending: [Pending] = []
    private(set) var delays: [Int64] = []
    // Retain callbacks independently of cancellation to simulate a timer already in flight.
    private(set) var scheduledCallbacks: [@Sendable () -> Void] = []
    var pendingCount: Int { pending.filter { !$0.token.isCancelled }.count }

    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) -> any OSLogPollCancellation {
        let token = Token()
        delays.append(milliseconds)
        scheduledCallbacks.append(callback)
        pending.append(Pending(deadline: time + milliseconds, token: token, callback: callback))
        return token
    }

    func advance(by milliseconds: Int64) {
        time += milliseconds
        let due = pending.filter { $0.deadline <= time }
        pending.removeAll { $0.deadline <= time || $0.token.isCancelled }
        for item in due where !item.token.isCancelled {
            item.callback()
        }
    }
}
