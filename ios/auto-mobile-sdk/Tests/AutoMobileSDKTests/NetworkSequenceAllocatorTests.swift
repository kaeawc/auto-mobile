@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class NetworkSequenceAllocatorTests: XCTestCase {
    func testNextReturnsStrictlyIncreasingNumbersFromOne() {
        let allocator = NetworkSequenceAllocator()

        XCTAssertEqual(allocator.next(), 1)
        XCTAssertEqual(allocator.next(), 2)
        XCTAssertEqual(allocator.next(), 3)
    }

    func testConcurrentNextNeverRepeatsANumber() {
        let allocator = NetworkSequenceAllocator()
        let numbers = OSAllocatedUnfairLock<[UInt64]>(initialState: [])

        DispatchQueue.concurrentPerform(iterations: 256) { _ in
            let number = allocator.next()
            numbers.withLock { $0.append(number) }
        }

        XCTAssertEqual(numbers.withLock { $0 }.sorted(), (1 ... 256).map { UInt64($0) })
    }

    func testRecordersFromOneNetworkGetDistinctSequenceNumbers() throws {
        let records = OSAllocatedUnfairLock<[NetworkRequestRecord]>(initialState: [])
        let first = AutoMobileNetwork.shared.makeCaptureRecorder(emit: { record in
            records.withLock { $0.append(record) }
        })
        let second = AutoMobileNetwork.shared.makeCaptureRecorder(emit: { record in
            records.withLock { $0.append(record) }
        })

        for recorder in [first, second] {
            WebSocketNetworkCaptureAdapter(recorder: recorder).recordFrame(
                url: "wss://example.test/socket",
                connectionId: "socket",
                direction: .sent,
                frameType: .text,
                payloadSize: 4
            )
        }

        let emitted = records.withLock { $0 }
        XCTAssertEqual(emitted.count, 2)
        let firstSequence = try XCTUnwrap(emitted.first?.sequenceNumber)
        let secondSequence = try XCTUnwrap(emitted.last?.sequenceNumber)
        XCTAssertNotEqual(firstSequence, secondSequence)
    }
}
