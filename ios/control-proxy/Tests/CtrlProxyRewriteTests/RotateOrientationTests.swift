@testable import CtrlProxyRewrite
import XCTest

@MainActor
final class RotateOrientationTests: XCTestCase {
    private func assertRotation(
        from previous: String,
        to target: String,
        performed: Bool,
        value: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        async throws
    {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation(previous)
        let callsBeforeRequest = gestures.setOrientationCalls
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: target)))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success, file: file, line: line)
        XCTAssertEqual(response.previousOrientation, previous, file: file, line: line)
        XCTAssertEqual(response.currentOrientation, target, file: file, line: line)
        XCTAssertEqual(response.rotationPerformed, performed, file: file, line: line)
        XCTAssertEqual(response.value, value, file: file, line: line)
        XCTAssertEqual(gestures.getOrientation(), target, file: file, line: line)
        XCTAssertEqual(gestures.setOrientationCalls - callsBeforeRequest, performed ? 1 : 0, file: file, line: line)
    }

    func testLandscapeLeftToRight() async throws {
        try await assertRotation(from: "landscape_left", to: "landscape_right", performed: true, value: 1)
    }

    func testLandscapeRightToLeft() async throws {
        try await assertRotation(from: "landscape_right", to: "landscape_left", performed: true, value: 1)
    }

    func testPortraitToUpsideDown() async throws {
        try await assertRotation(from: "portrait", to: "portrait_upside_down", performed: true, value: 0)
    }

    func testUpsideDownToPortrait() async throws {
        try await assertRotation(from: "portrait_upside_down", to: "portrait", performed: true, value: 0)
    }

    func testSameOrientationSkipsSetter() async throws {
        try await assertRotation(from: "landscape_left", to: "landscape_left", performed: false, value: 1)
    }

    func testUnsupportedDisplayKeepsPreviousOrientation() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        gestures.rotationSupported = false
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: "landscape")))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, "Rotation is not supported on this display (the screen size did not change)")
        XCTAssertEqual(response.currentOrientation, "unknown")
        XCTAssertFalse(response.rotationPerformed)
        let portraitResult = await handler.handle(.rotate(RequestRotate(
            requestId: "portrait-test",
            orientation: "portrait"
        )))
        let portraitResponse = try XCTUnwrap(portraitResult as? RotateResponse)
        XCTAssertTrue(portraitResponse.success)
        XCTAssertFalse(portraitResponse.rotationPerformed)
        XCTAssertEqual(gestures.setOrientationCalls, 2)
    }

    func testUnknownPortraitOnPortraitDisplayIsNoOp() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: "portrait")))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success)
        XCTAssertFalse(response.rotationPerformed)
        XCTAssertEqual(gestures.setOrientationCalls, 1)
    }
}
