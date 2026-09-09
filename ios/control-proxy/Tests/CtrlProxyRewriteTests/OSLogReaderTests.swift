@testable import CtrlProxyRewrite
import Foundation
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

    private enum TestError: Error { case unused }
}
