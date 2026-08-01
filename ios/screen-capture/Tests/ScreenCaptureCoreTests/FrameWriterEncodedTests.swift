import XCTest
@testable import ScreenCaptureCore

/// Sink that blocks the drain worker on its first write until released, so a
/// test can let records accumulate in the bounded queue.
private final class FirstWriteBlockingSink: FrameSink {
    private let lock = NSLock()
    private var writeCount = 0
    private let firstWriteStarted = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)

    func write(_ chunk: Data) {
        lock.lock()
        writeCount += 1
        let shouldBlock = writeCount == 1
        lock.unlock()
        if shouldBlock {
            firstWriteStarted.signal()
            _ = release.wait(timeout: .now() + 1)
        }
    }

    func waitForFirstWrite() -> Bool {
        firstWriteStarted.wait(timeout: .now() + 1) == .success
    }

    func allowOutput() {
        release.signal()
    }
}

/// Tests the ordered, never-drop encoded-record output path (issue #4788).
final class FrameWriterEncodedTests: XCTestCase {
    private struct Record {
        let header: Data
        let payload: Data
    }

    private func makeRecord(_ payload: [UInt8], keyframe: Bool, pts: UInt32) -> Record {
        let payloadData = Data(payload)
        let header = FrameProtocol.encodeEncodedVideoHeader(
            payloadLength: payloadData.count, isKeyframe: keyframe, presentationTimestampMs: pts
        )
        return Record(header: header, payload: payloadData)
    }

    func testWritesEncodedHeaderThenPayloadInOrder() {
        let sink = BufferSink()
        let writer = FrameWriter(sink: sink)
        let keyframe = makeRecord([0x00, 0x00, 0x00, 0x01, 0x67], keyframe: true, pts: 100)
        let delta = makeRecord([0x00, 0x00, 0x00, 0x01, 0x41], keyframe: false, pts: 133)

        XCTAssertTrue(writer.writeEncoded(header: keyframe.header, payload: keyframe.payload))
        XCTAssertTrue(writer.writeEncoded(header: delta.header, payload: delta.payload))
        writer.flush()

        XCTAssertEqual(sink.data, keyframe.header + keyframe.payload + delta.header + delta.payload)
    }

    func testNeverDropsEncodedRecordsUnderSlowSink() {
        // Records queue while the sink blocks; none may be dropped or reordered.
        let sink = BlockingPayloadSink()
        let writer = FrameWriter(sink: sink)
        let one = makeRecord([0xA1], keyframe: true, pts: 0)
        let two = makeRecord([0xA2], keyframe: false, pts: 1)
        let three = makeRecord([0xA3], keyframe: false, pts: 2)

        XCTAssertTrue(writer.writeEncoded(header: one.header, payload: one.payload))
        XCTAssertTrue(sink.waitForFirstPayload())
        XCTAssertTrue(writer.writeEncoded(header: two.header, payload: two.payload))
        XCTAssertTrue(writer.writeEncoded(header: three.header, payload: three.payload))
        sink.allowOutput()
        writer.flush()

        // Every payload survived, in submission order (payloads are the even writes).
        XCTAssertEqual(sink.payloads(), [one.payload, two.payload, three.payload])
    }

    func testEncodedOverflowReturnsFalseInsteadOfDropping() {
        // Block the drain worker on the very first write so subsequent records
        // accumulate in the bounded queue rather than draining one at a time.
        let sink = FirstWriteBlockingSink()
        let writer = FrameWriter(
            sink: sink,
            configuration: .init(maximumPendingEncodedBytes: 4)
        )
        let one = makeRecord([0x01, 0x02, 0x03], keyframe: true, pts: 0)   // 3 bytes
        let two = makeRecord([0x04, 0x05, 0x06], keyframe: false, pts: 1)  // fits: 0+3 <= 4
        let three = makeRecord([0x07, 0x08, 0x09], keyframe: false, pts: 2)  // 3+3 = 6 > 4

        XCTAssertTrue(writer.writeEncoded(header: one.header, payload: one.payload))
        XCTAssertTrue(sink.waitForFirstWrite())
        // one is dequeued and blocked in the sink; two fits the 4-byte cap.
        XCTAssertTrue(writer.writeEncoded(header: two.header, payload: two.payload))
        // three would overflow — signalled (fatal), never a silent drop.
        XCTAssertFalse(writer.writeEncoded(header: three.header, payload: three.payload))
        sink.allowOutput()
        writer.flush()
    }

    func testEncodedRecordsInterleaveWithAudioWithoutStarving() {
        let sink = BlockingPayloadSink()
        let writer = FrameWriter(sink: sink)
        let one = makeRecord([0xE1], keyframe: true, pts: 0)
        let two = makeRecord([0xE2], keyframe: false, pts: 1)
        let audioA = Data([0xAA])
        let audioB = Data([0xBB])

        XCTAssertTrue(writer.writeEncoded(header: one.header, payload: one.payload))
        XCTAssertTrue(sink.waitForFirstPayload())
        writer.writeAudio(pcm16le: audioA)
        writer.writeAudio(pcm16le: audioB)
        XCTAssertTrue(writer.writeEncoded(header: two.header, payload: two.payload))
        sink.allowOutput()
        writer.flush()

        // Media alternates with audio: encoded, audioA, encoded, audioB.
        XCTAssertEqual(sink.payloads(), [one.payload, audioA, two.payload, audioB])
    }
}
