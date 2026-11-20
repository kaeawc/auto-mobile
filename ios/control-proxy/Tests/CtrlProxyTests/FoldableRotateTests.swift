@testable import CtrlProxy
import XCTest

private actor FakeSimulatedOrientationSetter: SimulatedOrientationSetting {
    private var sent: [SimulatedDeviceOrientation] = []
    private let failure: HingeAngleError?

    init(failure: HingeAngleError? = nil) { self.failure = failure }

    func setDeviceOrientation(_ orientation: SimulatedDeviceOrientation) async throws {
        sent.append(orientation)
        if let failure { throw failure }
    }

    func calls() -> [SimulatedDeviceOrientation] { sent }
}

@MainActor
final class FoldableRotateTests: XCTestCase {
    private func rotate(
        _ orientation: String,
        panel: String?,
        axes: [AppAxis?],
        setter: FakeSimulatedOrientationSetter,
        gestures: FakeGesturePerformer = FakeGesturePerformer(),
        timer: FakeProxyTimer = FakeProxyTimer(mode: .instant)
    )
        async throws -> RotateResponse
    {
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: axes),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            simulatedOrientationSetter: setter,
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(
            requestId: "rotate-foldable", orientation: orientation, panel: panel
        )))
        return try XCTUnwrap(result as? RotateResponse)
    }

    func testInnerPanelLandscapeToPortraitPostsLandscapeLeftPose() async throws {
        let setter = FakeSimulatedOrientationSetter()
        let gestures = FakeGesturePerformer()
        let response = try await rotate(
            "portrait", panel: "inner", axes: [.landscape, .landscape, .portrait], setter: setter, gestures: gestures
        )
        XCTAssertTrue(response.success)
        XCTAssertTrue(response.rotationPerformed)
        XCTAssertEqual(response.previousOrientation, "landscape")
        XCTAssertEqual(response.currentOrientation, "portrait")
        XCTAssertEqual(response.value, 0)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [.landscapeLeft])
        XCTAssertEqual(gestures.setOrientationCalls, 0)
    }

    func testCoverPanelPortraitToLandscapePostsLandscapeLeftPose() async throws {
        let setter = FakeSimulatedOrientationSetter()
        let response = try await rotate("landscape", panel: "cover", axes: [.portrait, .landscape], setter: setter)
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.currentOrientation, "landscape_left")
        XCTAssertEqual(response.value, 1)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [.landscapeLeft])
    }

    func testInnerPanelLandscapeTargetPostsPortraitPose() async throws {
        let setter = FakeSimulatedOrientationSetter()
        let response = try await rotate("landscape", panel: "inner", axes: [.portrait, .landscape], setter: setter)
        XCTAssertTrue(response.success)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [.portrait])
    }

    func testMatchingAxisIsANoOpWithoutPosting() async throws {
        let setter = FakeSimulatedOrientationSetter()
        let response = try await rotate("landscape", panel: "inner", axes: [.landscape], setter: setter)
        XCTAssertTrue(response.success)
        XCTAssertFalse(response.rotationPerformed)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [])
    }

    func testUnchangedAxisFailsAfterTheDeadlineWithTheRunnerRefusal() async throws {
        let setter = FakeSimulatedOrientationSetter()
        let timer = FakeProxyTimer(mode: .instant)
        let response = try await rotate("landscape", panel: "cover", axes: [.portrait], setter: setter, timer: timer)
        XCTAssertFalse(response.success)
        XCTAssertFalse(response.rotationPerformed)
        XCTAssertEqual(response.error, RotateDecision.unchangedAxisError)
        XCTAssertEqual(response.currentOrientation, "portrait")
        XCTAssertEqual(response.value, 0)
        XCTAssertEqual(timer.now(), RotateDecision.timeoutMs)
    }

    func testUnsupportedPlatformFallsBackToXCUIDevice() async throws {
        let setter = FakeSimulatedOrientationSetter(failure: .unsupportedPlatform)
        let gestures = FakeGesturePerformer()
        let response = try await rotate(
            "landscape", panel: "cover", axes: [.portrait, .portrait, .landscape], setter: setter, gestures: gestures
        )
        XCTAssertTrue(response.success)
        XCTAssertEqual(gestures.setOrientationCalls, 1)
        XCTAssertEqual(gestures.getOrientation(), "landscape_left")
    }

    func testNoPanelKeepsTheXCUIDevicePath() async throws {
        let setter = FakeSimulatedOrientationSetter()
        let gestures = FakeGesturePerformer()
        let response = try await rotate(
            "landscape", panel: nil, axes: [.portrait, .landscape], setter: setter, gestures: gestures
        )
        XCTAssertTrue(response.success)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(gestures.setOrientationCalls, 1)
    }

    func testPanelMapping() {
        let cases: [(FoldablePanel, String, SimulatedDeviceOrientation)] = [
            (.cover, "portrait", .portrait),
            (.cover, "portrait_upside_down", .portrait),
            (.cover, "landscape_left", .landscapeLeft),
            (.cover, "landscape_right", .landscapeRight),
            (.inner, "portrait", .landscapeLeft),
            (.inner, "portrait_upside_down", .landscapeRight),
            (.inner, "landscape_left", .portrait),
            (.inner, "landscape_right", .portrait),
        ]
        for (panel, request, expected) in cases {
            guard let target = RotateTarget(request) else {
                XCTFail("unparsed \(request)")
                continue
            }
            XCTAssertEqual(panel.deviceOrientation(for: target), expected, "\(panel) \(request)")
        }
    }
}
