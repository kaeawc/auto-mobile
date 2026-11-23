@testable import ScreenCaptureCore
import XCTest

final class FramebufferFrameGateTests: XCTestCase {
    func testFirstTickEncodes() {
        let gate = FramebufferFrameGate()
        XCTAssertTrue(gate.shouldEncode(surfaceID: 31, seed: 1502, keyFrameRequested: false))
    }

    func testUnchangedSeedEncodesNothing() {
        var gate = FramebufferFrameGate()
        gate.recordEncoded(surfaceID: 31, seed: 1502)
        XCTAssertFalse(gate.shouldEncode(surfaceID: 31, seed: 1502, keyFrameRequested: false))
    }

    func testNewSeedOrNewSurfaceEncodes() {
        var gate = FramebufferFrameGate()
        gate.recordEncoded(surfaceID: 31, seed: 1502)
        XCTAssertTrue(gate.shouldEncode(surfaceID: 31, seed: 1503, keyFrameRequested: false))
        XCTAssertTrue(gate.shouldEncode(surfaceID: 32, seed: 1502, keyFrameRequested: false))
    }

    func testKeyFrameRequestReencodesStaticScreen() {
        var gate = FramebufferFrameGate()
        gate.recordEncoded(surfaceID: 31, seed: 1502)
        XCTAssertTrue(gate.shouldEncode(surfaceID: 31, seed: 1502, keyFrameRequested: true))
    }

    func testDroppedFrameIsRetriedBecauseOnlyAcceptedFramesAreRecorded() {
        var gate = FramebufferFrameGate()
        gate.recordEncoded(surfaceID: 31, seed: 1502)
        // Seed 1503 was offered but the encoder dropped it, so nothing was recorded.
        XCTAssertTrue(gate.shouldEncode(surfaceID: 31, seed: 1503, keyFrameRequested: false))
        XCTAssertTrue(gate.shouldEncode(surfaceID: 31, seed: 1503, keyFrameRequested: false))
    }

    func testSurfaceIsRefetchedOnTheRefreshInterval() {
        var gate = FramebufferFrameGate(surfaceRefreshInterval: 1.0)
        XCTAssertTrue(gate.shouldRefetchSurface(now: 10.0))
        gate.recordSurfaceFetch(now: 10.0)
        XCTAssertFalse(gate.shouldRefetchSurface(now: 10.9))
        XCTAssertTrue(gate.shouldRefetchSurface(now: 11.0))
    }
}
