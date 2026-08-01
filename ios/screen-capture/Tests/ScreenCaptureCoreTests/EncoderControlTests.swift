import XCTest
@testable import ScreenCaptureCore

/// Pure tests for the encoder control surface (issue #4788): the STDIN command
/// parser, the force-keyframe latch, and the drop-policy decisions.
final class EncoderControlTests: XCTestCase {
    func testParsesForceKeyFrame() {
        XCTAssertEqual(EncoderControlCommand.parse(line: "{\"cmd\":\"forceKeyFrame\"}"), .forceKeyFrame)
        // Whitespace and extra keys are tolerated.
        XCTAssertEqual(
            EncoderControlCommand.parse(line: "  {\"cmd\":\"forceKeyFrame\",\"seq\":7}  "),
            .forceKeyFrame
        )
    }

    func testIgnoresMalformedAndUnknownCommands() {
        XCTAssertNil(EncoderControlCommand.parse(line: ""))
        XCTAssertNil(EncoderControlCommand.parse(line: "   "))
        XCTAssertNil(EncoderControlCommand.parse(line: "not json"))
        XCTAssertNil(EncoderControlCommand.parse(line: "{\"cmd\":\"unknown\"}"))
        XCTAssertNil(EncoderControlCommand.parse(line: "{\"nope\":1}"))
        XCTAssertNil(EncoderControlCommand.parse(line: "{\"cmd\":123}"))
        XCTAssertNil(EncoderControlCommand.parse(line: "[\"forceKeyFrame\"]"))
    }

    func testLatchConsumesExactlyOnce() {
        let latch = ForceKeyFrameLatch()
        XCTAssertFalse(latch.isPending)
        XCTAssertFalse(latch.consume())

        latch.request()
        XCTAssertTrue(latch.isPending)
        XCTAssertTrue(latch.consume(), "the next frame is forced to an IDR")
        XCTAssertFalse(latch.consume(), "subsequent frames are not forced")
        XCTAssertFalse(latch.isPending)
    }

    func testLatchRequestIsIdempotentUntilConsumed() {
        let latch = ForceKeyFrameLatch()
        latch.request()
        latch.request()
        XCTAssertTrue(latch.consume())
        XCTAssertFalse(latch.consume())
    }

    func testDropsBeforeEncodeOnlyWhenBehind() {
        XCTAssertFalse(EncoderDropPolicy.shouldDropBeforeEncode(inFlightFrames: 0, maxInFlightFrames: 3))
        XCTAssertFalse(EncoderDropPolicy.shouldDropBeforeEncode(inFlightFrames: 2, maxInFlightFrames: 3))
        XCTAssertTrue(EncoderDropPolicy.shouldDropBeforeEncode(inFlightFrames: 3, maxInFlightFrames: 3))
        XCTAssertTrue(EncoderDropPolicy.shouldDropBeforeEncode(inFlightFrames: 9, maxInFlightFrames: 3))
    }

    func testOutputQueueOverflowDecision() {
        XCTAssertFalse(
            EncoderDropPolicy.wouldOverflowOutputQueue(queuedBytes: 10, recordBytes: 20, maxQueuedBytes: 30)
        )
        XCTAssertTrue(
            EncoderDropPolicy.wouldOverflowOutputQueue(queuedBytes: 10, recordBytes: 21, maxQueuedBytes: 30)
        )
    }
}
