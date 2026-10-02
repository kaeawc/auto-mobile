@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class NetworkCaptureRecorderConcurrencyTests: XCTestCase {
    func testConcurrentBeginAndFinishEmitsExactlyOneRecordPerRequest() {
        let records = OSAllocatedUnfairLock<[NetworkRequestRecord]>(initialState: [])
        let identifiers = OSAllocatedUnfairLock(initialState: 0)
        let recorder = NetworkCaptureRecorder(
            emit: { record in records.withLock { $0.append(record) } },
            idGenerator: {
                identifiers.withLock { next in
                    next += 1
                    return "request-\(next)"
                }
            },
            sampler: { 0 }
        )

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let requestId = recorder.beginRequest(url: "https://example.test/\(index)")
            recorder.recordResponseBodyChunk(requestId: requestId, bytes: 4, text: "body")
            recorder.recordCompletion(requestId: requestId, statusCode: 200)
            recorder.recordResponseBodyChunk(requestId: requestId, bytes: 4, text: "late")
            recorder.recordFailure(requestId: requestId, error: "late failure")
            recorder.recordCompletion(requestId: requestId, statusCode: 500)
        }

        let emitted = records.withLock { $0 }
        XCTAssertEqual(emitted.count, 32)
        XCTAssertEqual(Set(emitted.compactMap(\.requestId)), Set((1 ... 32).map { "request-\($0)" }))
        XCTAssertEqual(Set(emitted.map(\.url)), Set((0 ..< 32).map { "https://example.test/\($0)" }))
        XCTAssertTrue(emitted.allSatisfy {
            $0.statusCode == 200 && $0.error == nil && $0.responseBodySize == 4 && $0.responseBody == "body"
        })
        // Concurrent sink arrival can be out of order. Sequence numbers restore the total order.
        XCTAssertEqual(emitted.compactMap(\.sequenceNumber).sorted(), (1 ... 32).map { UInt64($0) })
    }

    func testConcurrentCompletionAndFailureEmitOnlyOneTerminalRecord() {
        let records = OSAllocatedUnfairLock<[NetworkRequestRecord]>(initialState: [])
        let identifiers = OSAllocatedUnfairLock(initialState: 0)
        let recorder = NetworkCaptureRecorder(
            emit: { record in records.withLock { $0.append(record) } },
            idGenerator: {
                identifiers.withLock { next in
                    next += 1
                    return "request-\(next)"
                }
            },
            sampler: { 0 }
        )
        let requestIds = (0 ..< 16).map { recorder.beginRequest(url: "https://example.test/\($0)") }

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let requestId = requestIds[index / 2]
            if index.isMultiple(of: 2) {
                recorder.recordCompletion(requestId: requestId, statusCode: 204)
            } else {
                recorder.recordFailure(requestId: requestId, error: "failed")
            }
        }

        let emitted = records.withLock { $0 }
        XCTAssertEqual(emitted.count, requestIds.count)
        XCTAssertEqual(Set(emitted.compactMap(\.requestId)), Set(requestIds))
        XCTAssertTrue(emitted.allSatisfy {
            ($0.statusCode == 204 && $0.error == nil) || ($0.statusCode == nil && $0.error == "failed")
        })
        XCTAssertEqual(emitted.compactMap(\.sequenceNumber).sorted(), (1 ... 16).map { UInt64($0) })
    }

    func testSerialCallsDeliverMonotonicSequencesBeforeReturning() {
        let records = OSAllocatedUnfairLock<[NetworkRequestRecord]>(initialState: [])
        let recorder = NetworkCaptureRecorder(
            emit: { record in records.withLock { $0.append(record) } },
            idGenerator: { "serial-request" },
            sampler: { 0 }
        )
        let completedId = recorder.beginRequest(url: "https://example.test/completed")
        recorder.recordCompletion(requestId: completedId, statusCode: 200)
        XCTAssertEqual(records.withLock { $0.compactMap(\.sequenceNumber) }, [1])

        recorder.recordWebSocketFrame(
            url: "wss://example.test/socket", connectionId: "socket", direction: .sent,
            frameType: .text, payloadSize: 4
        )
        XCTAssertEqual(records.withLock { $0.compactMap(\.sequenceNumber) }, [1, 2])

        let failedId = recorder.beginRequest(url: "https://example.test/failed")
        recorder.recordFailure(requestId: failedId, error: "failed")
        XCTAssertEqual(records.withLock { $0.compactMap(\.sequenceNumber) }, [1, 2, 3])
    }

    func testEmitCanReenterRequestStateAndEmissionWithoutDeadlock() {
        let records = OSAllocatedUnfairLock<[NetworkRequestRecord]>(initialState: [])
        let recorderReference = OSAllocatedUnfairLock<NetworkCaptureRecorder?>(initialState: nil)
        let recorder = NetworkCaptureRecorder(
            emit: { record in
                records.withLock { $0.append(record) }
                if record.url == "https://example.test/outer",
                   let inner = recorderReference.withLock({ $0 })
                {
                    let requestId = inner.beginRequest(url: "https://example.test/inner")
                    inner.recordMetadata(requestId: requestId, key: "reentered", value: "true")
                    inner.recordCompletion(requestId: requestId, statusCode: 201)
                }
            },
            idGenerator: { "reentrant-request" },
            sampler: { 0 }
        )
        recorderReference.withLock { $0 = recorder }
        defer { recorderReference.withLock { $0 = nil } }

        let requestId = recorder.beginRequest(url: "https://example.test/outer")
        recorder.recordCompletion(requestId: requestId, statusCode: 200)

        let emitted = records.withLock { $0 }
        XCTAssertEqual(emitted.map(\.url), ["https://example.test/outer", "https://example.test/inner"])
        XCTAssertEqual(emitted.compactMap(\.sequenceNumber), [1, 2])
        XCTAssertEqual(emitted.last?.metadata?["reentered"], "true")
    }

    func testRecorderAndAdaptersAreSendable() {
        func requireSendable<T: Sendable>(_: T.Type) {}

        requireSendable(NetworkCaptureRecorder.self)
        requireSendable(URLSessionNetworkCaptureAdapter.self)
        requireSendable(WebSocketNetworkCaptureAdapter.self)
        requireSendable(NWConnectionNetworkCaptureAdapter.self)
        requireSendable(NetworkRequestRecord.self)
        requireSendable(NetworkCaptureDirection.self)
    }
}
