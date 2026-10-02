@testable import CtrlProxyRewrite
import XCTest

final class RotateDecisionTests: XCTestCase {
    private func decision(_ request: String, app: AppAxis?, device: String) throws -> RotateDecision {
        try RotateDecision(target: XCTUnwrap(RotateTarget(request)), appAxisBefore: app, deviceBefore: device)
    }

    private func pollSequence(
        _ decision: RotateDecision,
        axes: [AppAxis?],
        devices: [String]
    )
        -> RotateOutcome
    {
        for index in axes.indices {
            let outcome = decision.poll(
                appAxis: axes[index], device: devices[index], deadlineReached: index == axes.count - 1
            )
            if outcome != .pending { return outcome }
        }
        return .pending
    }

    func testIssueLandscapeWaitsForAppAxis() throws {
        for deviceBefore in ["unknown", "portrait"] {
            let decision = try decision("landscape", app: .portrait, device: deviceBefore)
            XCTAssertEqual(decision.initial(), .pending)
            XCTAssertEqual(
                decision.poll(appAxis: .portrait, device: "landscape_left", deadlineReached: false),
                .pending
            )
            let outcome = pollSequence(
                decision, axes: [.portrait, .landscape], devices: ["landscape_left", "landscape_left"]
            )
            let result = try XCTUnwrap(outcome.result)
            XCTAssertEqual(outcome, .success(result))
            XCTAssertEqual(result.previousOrientation, "portrait")
            XCTAssertEqual(result.currentOrientation, "landscape_left")
            XCTAssertTrue(result.rotationPerformed)
            XCTAssertEqual(result.value, 1)
        }
    }

    func testIssuePortraitFromLandscapePerformsSet() throws {
        let decision = try decision("portrait", app: .landscape, device: "landscape_left")
        XCTAssertEqual(decision.initial(), .pending)
        let outcome = pollSequence(decision, axes: [.landscape, .portrait], devices: ["portrait", "portrait"])
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .success(result))
        XCTAssertEqual(result.previousOrientation, "landscape_left")
        XCTAssertEqual(result.currentOrientation, "portrait")
        XCTAssertTrue(result.rotationPerformed)
        XCTAssertEqual(result.value, 0)
    }

    func testPortraitAppOverridesStaleLandscapeOnNoOp() throws {
        let outcome = try decision("portrait", app: .portrait, device: "landscape_left").initial()
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .noOp(result))
        XCTAssertEqual(result.previousOrientation, "portrait")
        XCTAssertEqual(result.currentOrientation, "portrait")
        XCTAssertFalse(result.rotationPerformed)
    }

    func testLandscapeAppWithUnknownDeviceIsCoarseNoOp() throws {
        let outcome = try decision("landscape", app: .landscape, device: "unknown").initial()
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .noOp(result))
        XCTAssertEqual(result.previousOrientation, "landscape")
        XCTAssertEqual(result.currentOrientation, "landscape")
    }

    func testUnknownAndUnavailableNeverNoOp() throws {
        for request in ["portrait", "landscape", "portrait_upside_down", "landscape_left", "landscape_right"] {
            XCTAssertEqual(try decision(request, app: nil, device: "unknown").initial(), .pending)
        }
    }

    func testUnavailableSourceUsesKnownDeviceForNoOp() throws {
        for request in ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"] {
            let outcome = try decision(request, app: nil, device: request).initial()
            let result = try XCTUnwrap(outcome.result)
            XCTAssertEqual(outcome, .noOp(result))
            XCTAssertEqual(result.currentOrientation, request)
        }
        let coarse = try decision("landscape", app: nil, device: "landscape_right").initial()
        XCTAssertEqual(coarse, try .noOp(XCTUnwrap(coarse.result)))
    }

    func testUnavailableMismatchUsesDevicePoll() throws {
        let decision = try decision("landscape", app: nil, device: "portrait")
        XCTAssertEqual(decision.initial(), .pending)
        let outcome = pollSequence(decision, axes: [nil, nil], devices: ["portrait", "landscape_left"])
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .success(result))
        XCTAssertTrue(result.rotationPerformed)
        let failure = decision.poll(appAxis: nil, device: "portrait", deadlineReached: true)
        XCTAssertEqual(failure.result?.error, "Rotation to landscape_left is not supported on this display")
        XCTAssertEqual(failure.result?.value, 0)
        XCTAssertEqual(failure.result?.rotationPerformed, false)
    }

    func testFixedPortraitDisplayFailsOnlyAtDeadline() throws {
        let decision = try decision("landscape", app: .portrait, device: "unknown")
        XCTAssertEqual(decision.initial(), .pending)
        for _ in 0 ..< 20 {
            XCTAssertEqual(
                decision.poll(appAxis: .portrait, device: "landscape_left", deadlineReached: false),
                .pending
            )
        }
        let outcome = decision.poll(appAxis: .portrait, device: "landscape_left", deadlineReached: true)
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .failure(result))
        XCTAssertEqual(result.error, "Rotation is not supported on this display (the screen size did not change)")
        XCTAssertEqual(result.previousOrientation, "portrait")
        XCTAssertEqual(result.currentOrientation, "portrait")
        XCTAssertEqual(result.value, 0)
        XCTAssertFalse(result.rotationPerformed)
    }

    func testSameAxisDirectionChangeRequiresDeviceMatch() throws {
        let decision = try decision("landscape_right", app: .landscape, device: "landscape_left")
        XCTAssertEqual(decision.initial(), .pending)
        let outcome = pollSequence(
            decision, axes: [.landscape, .landscape], devices: ["landscape_left", "landscape_right"]
        )
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .success(result))
        XCTAssertEqual(result.currentOrientation, "landscape_right")
        XCTAssertTrue(result.rotationPerformed)
        let failure = decision.poll(appAxis: .landscape, device: "landscape_left", deadlineReached: true)
        XCTAssertEqual(failure.result?.error, "Rotation to landscape_right is not supported on this display")
        XCTAssertEqual(failure.result?.currentOrientation, "landscape_left")
        XCTAssertEqual(failure.result?.value, 1)
        XCTAssertEqual(failure.result?.rotationPerformed, false)
    }

    func testSpecificDirectionWithUnknownDeviceStillSets() throws {
        for request in ["landscape_left", "landscape_right", "portrait_upside_down"] {
            let target = try XCTUnwrap(RotateTarget(request))
            XCTAssertEqual(try decision(request, app: target.axis, device: "unknown").initial(), .pending)
        }
    }

    func testAppUnavailableAtDeadlineFallsBackToDeviceMatch() throws {
        let decision = try decision("landscape", app: .portrait, device: "portrait")
        XCTAssertEqual(decision.poll(appAxis: nil, device: "landscape_left", deadlineReached: false), .pending)
        let outcome = pollSequence(decision, axes: [.portrait, nil], devices: ["landscape_left", "landscape_left"])
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .success(result))
        XCTAssertEqual(result.currentOrientation, "landscape_left")
        XCTAssertTrue(result.rotationPerformed)
        let failure = decision.poll(appAxis: nil, device: "portrait", deadlineReached: true)
        XCTAssertEqual(failure.result?.error, "Rotation to landscape_left is not supported on this display")
    }

    func testAppCanRecoverBeforeDeadline() throws {
        let decision = try decision("landscape", app: .portrait, device: "portrait")
        let outcome = pollSequence(decision, axes: [nil, .landscape], devices: ["landscape_left", "unknown"])
        let result = try XCTUnwrap(outcome.result)
        XCTAssertEqual(outcome, .success(result))
        XCTAssertEqual(result.currentOrientation, "landscape")
    }

    func testCoarseAndDetailedAxisCollapse() {
        for orientation in ["landscape", "landscape_left", "landscape_right"] {
            XCTAssertEqual(AppAxis.from(orientation: orientation), .landscape)
        }
        for orientation in ["portrait", "portrait_upside_down"] {
            XCTAssertEqual(AppAxis.from(orientation: orientation), .portrait)
        }
        XCTAssertNil(AppAxis.from(orientation: "unknown"))
    }

    func testRequestAliasesAndRejection() {
        XCTAssertEqual(RotateTarget("LANDSCAPE")?.orientation, "landscape_left")
        XCTAssertEqual(RotateTarget("LandscapeLeft")?.orientation, "landscape_left")
        XCTAssertEqual(RotateTarget("LANDSCAPERIGHT")?.orientation, "landscape_right")
        XCTAssertEqual(RotateTarget("PortraitUpsideDown")?.orientation, "portrait_upside_down")
        XCTAssertNil(RotateTarget("unknown"))
        XCTAssertNil(RotateTarget(" portrait "))
    }

    func testInvalidDimensionsAreUnavailable() {
        XCTAssertEqual(AppAxis.from(width: 402, height: 874), .portrait)
        XCTAssertEqual(AppAxis.from(width: 874, height: 402), .landscape)
        XCTAssertNil(AppAxis.from(width: 402, height: 402))
        XCTAssertNil(AppAxis.from(width: 0, height: 874))
        XCTAssertNil(AppAxis.from(width: 402, height: -1))
    }

    func testReportedOrientationPreservesDetailOnlyOnMatchingAxis() {
        XCTAssertEqual(
            RotateDecision.reportedOrientation(appAxis: .portrait, device: "portrait_upside_down"),
            "portrait_upside_down"
        )
        XCTAssertEqual(RotateDecision.reportedOrientation(appAxis: .landscape, device: "portrait"), "landscape")
        XCTAssertEqual(RotateDecision.reportedOrientation(appAxis: nil, device: "landscape_right"), "landscape_right")
        XCTAssertEqual(RotateDecision.reportedOrientation(appAxis: nil, device: "unknown"), "unknown")
    }
}
