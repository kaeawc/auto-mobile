import XCTest
@testable import ScreenCaptureCore
@testable import ScreenCaptureHelper

/// Tests the STDIN control-channel framing (issue #4788): newline-delimited JSON
/// is split and dispatched, partial lines buffer across chunks, and malformed
/// lines are ignored. The `ingest` seam avoids needing a real pipe.
final class ControlChannelTests: XCTestCase {
    private func collect(_ chunks: [String]) -> [EncoderControlCommand] {
        var received: [EncoderControlCommand] = []
        let channel = ControlChannel { received.append($0) }
        for chunk in chunks {
            channel.ingest(Data(chunk.utf8))
        }
        return received
    }

    func testDispatchesForceKeyFrameLine() {
        XCTAssertEqual(collect(["{\"cmd\":\"forceKeyFrame\"}\n"]), [.forceKeyFrame])
    }

    func testBuffersPartialLineAcrossChunks() {
        let received = collect(["{\"cmd\":", "\"forceKeyFrame\"}\n"])
        XCTAssertEqual(received, [.forceKeyFrame])
    }

    func testDispatchesMultipleLinesInOneChunk() {
        let received = collect(["{\"cmd\":\"forceKeyFrame\"}\n{\"cmd\":\"forceKeyFrame\"}\n"])
        XCTAssertEqual(received, [.forceKeyFrame, .forceKeyFrame])
    }

    func testIgnoresMalformedAndUnknownLines() {
        let received = collect([
            "garbage\n",
            "{\"cmd\":\"unknown\"}\n",
            "{\"cmd\":\"forceKeyFrame\"}\n",
        ])
        XCTAssertEqual(received, [.forceKeyFrame])
    }

    func testDoesNotDispatchUntilNewline() {
        // No trailing newline: the command is not yet complete.
        XCTAssertEqual(collect(["{\"cmd\":\"forceKeyFrame\"}"]), [])
    }
}
