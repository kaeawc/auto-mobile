@testable import CtrlProxy
import Foundation
import XCTest

private actor FakeHingeAngleSetter: HingeAngleSetting {
    private var angles: [Double] = []
    private let failure: HingeAngleError?
    private let onSet: @MainActor @Sendable () -> Void

    init(failure: HingeAngleError? = nil, onSet: @escaping @MainActor @Sendable () -> Void = {}) {
        self.failure = failure
        self.onSet = onSet
    }

    func setHingeAngle(_ degrees: Double) async throws {
        angles.append(degrees)
        if let failure { throw failure }
        await onSet()
    }

    func calls() -> [Double] { angles }
}

@MainActor
final class SetHingeAngleCommandTests: XCTestCase {
    private func handler(
        setter: FakeHingeAngleSetter,
        locator: FakeElementLocator = FakeElementLocator()
    )
        -> CommandHandler
    {
        CommandHandler(
            elementLocator: locator,
            gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(),
            hingeAngleSetter: setter
        )
    }

    func testDecodesAndSetsAngle() async throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"set_hinge_angle","requestId":"r1","angle":180}"#.utf8
        ))
        let locator = FakeElementLocator()
        let setter = FakeHingeAngleSetter {
            XCTAssertEqual(locator.geometryRefreshCalls, 0, "Refresh must follow the angle change")
        }
        let result = await handler(setter: setter, locator: locator).handle(request)
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertEqual(response.type, "hinge_angle_result")
        XCTAssertEqual(response.requestId, "r1")
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.angle, 180)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [180])
        XCTAssertEqual(locator.geometryRefreshCalls, 1)
        XCTAssertEqual(locator.filteringRequests, [false])
    }

    func testRejectsOutOfRangeWithoutSetterCall() async throws {
        let setter = FakeHingeAngleSetter()
        let locator = FakeElementLocator()
        let result = await handler(setter: setter, locator: locator).handle(
            .setHingeAngle(RequestSetHingeAngle(requestId: "r2", angle: 181))
        )
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertFalse(response.success)
        XCTAssertNotNil(response.error)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(locator.geometryRefreshCalls, 0)
    }

    func testSetterFailureIsTypedResult() async throws {
        let setter = FakeHingeAngleSetter(failure: .dispatchFailed)
        let locator = FakeElementLocator()
        let result = await handler(setter: setter, locator: locator).handle(
            .setHingeAngle(RequestSetHingeAngle(requestId: "r3", angle: 130))
        )
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, HingeAngleError.dispatchFailed.localizedDescription)
        XCTAssertNil(response.angle)
        XCTAssertEqual(locator.geometryRefreshCalls, 0)
    }

    func testGeometryCaptureFailureAfterAngleIsAppliedIsReported() async throws {
        let setter = FakeHingeAngleSetter()
        let locator = FakeElementLocator()
        locator.onCapture = { throw VerbatimLocalizedError(message: "capture failed") }
        let result = await handler(setter: setter, locator: locator).handle(
            .setHingeAngle(RequestSetHingeAngle(requestId: "r4", angle: 180))
        )
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, "capture failed")
        XCTAssertNil(response.angle)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [180])
        XCTAssertEqual(locator.geometryRefreshCalls, 1)
        XCTAssertNil(locator.gestureGeometry)
    }
}

@MainActor
final class RefreshGeometryCommandTests: XCTestCase {
    private func refresh(_ locator: FakeElementLocator) async throws -> RefreshGeometryResponse {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"refresh_geometry","requestId":"geometry-1"}"#.utf8
        ))
        XCTAssertEqual(request.typeString, "refresh_geometry")
        XCTAssertEqual(request.requestId, "geometry-1")
        XCTAssertEqual(request.requestType.responseType, .refreshGeometryResult)
        let result = await CommandHandler(
            elementLocator: locator, gesturePerformer: FakeGesturePerformer(), perf: PerfProvider()
        ).handle(request)
        return try XCTUnwrap(result as? RefreshGeometryResponse)
    }

    private func geometry(app: GestureSize, observation: GestureSize, rotation: Int?) -> GestureCoordinateGeometry {
        GestureCoordinateGeometry(
            app: app, screen: GestureSize(width: 402, height: 874), observation: observation,
            rotation: GestureCoordinateGeometry.observationRotation(rotation, size: observation, app: app)
        )
    }

    func testClearsCoverGeometryAndRebuildsFromCapture() async throws {
        let locator = FakeElementLocator()
        locator.gestureGeometry = geometry(
            app: GestureSize(width: 402, height: 874), observation: GestureSize(width: 402, height: 874), rotation: 0
        )
        locator.nextGestureGeometry = geometry(
            app: GestureSize(width: 669, height: 951), observation: GestureSize(width: 951, height: 669), rotation: 0
        )
        locator.onCapture = { XCTAssertNil(locator.gestureGeometry, "Old geometry must be gone before capture") }

        let response = try await refresh(locator)

        XCTAssertEqual(locator.geometryRefreshCalls, 1)
        XCTAssertEqual(locator.filteringRequests, [false])
        XCTAssertEqual(locator.gestureGeometry, locator.nextGestureGeometry)
        XCTAssertEqual(response.type, "refresh_geometry_result")
        XCTAssertEqual(response.requestId, "geometry-1")
        XCTAssertTrue(response.success)
        XCTAssertTrue(response.refreshed)
        XCTAssertEqual(response.rotation, 1)
        XCTAssertEqual(response.appWidth, 669)
        XCTAssertEqual(response.appHeight, 951)
        XCTAssertEqual(response.screenWidth, 402)
        XCTAssertEqual(response.screenHeight, 874)
        XCTAssertEqual(response.observationWidth, 951)
        XCTAssertEqual(response.observationHeight, 669)
        XCTAssertEqual(response.foregroundBundleId, "com.test.app")
        let wire = try XCTUnwrap(
            JSONSerialization
                .jsonObject(with: response.encoded(with: JSONEncoder())) as? [String: Any]
        )
        XCTAssertEqual(wire["appWidth"] as? Double, 669)
        XCTAssertEqual(wire["observationHeight"] as? Double, 669)
        XCTAssertEqual(wire["rotation"] as? Int, 1)
        XCTAssertEqual(wire["refreshed"] as? Bool, true)
    }

    func testLandscapeNativeAppKeepsRotationZero() async throws {
        let locator = FakeElementLocator()
        let landscape = GestureSize(width: 951, height: 669)
        locator.nextGestureGeometry = geometry(app: landscape, observation: landscape, rotation: 0)

        let response = try await refresh(locator)

        XCTAssertTrue(response.refreshed)
        XCTAssertEqual(response.rotation, 0)
        XCTAssertEqual(locator.gestureGeometry?.rotation, 0)
    }

    func testUnavailableGeometryDoesNotReportRefreshed() async throws {
        let response = try await refresh(FakeElementLocator())
        XCTAssertTrue(response.success)
        XCTAssertFalse(response.refreshed)
        XCTAssertNil(response.appWidth)
        XCTAssertNil(response.rotation)
    }

    func testUnknownRotationIsNullOnWireAndStillRefreshed() async throws {
        let locator = FakeElementLocator()
        locator.nextGestureGeometry = GestureCoordinateGeometry(
            app: GestureSize(width: 402, height: 874), screen: GestureSize(width: 402, height: 874),
            observation: GestureSize(width: 402, height: 874), rotation: nil
        )
        let response = try await refresh(locator)
        XCTAssertTrue(response.refreshed)
        XCTAssertNil(response.rotation)
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any])
        XCTAssertTrue(wire["rotation"] is NSNull)
    }

    func testCaptureFailureLeavesOldGeometryClearedAndReturnsTypedFailure() async throws {
        let locator = FakeElementLocator()
        locator.gestureGeometry = geometry(
            app: GestureSize(width: 402, height: 874), observation: GestureSize(width: 402, height: 874), rotation: 0
        )
        locator.onCapture = { throw VerbatimLocalizedError(message: "capture failed") }

        let response = try await refresh(locator)

        XCTAssertFalse(response.success)
        XCTAssertFalse(response.refreshed)
        XCTAssertEqual(response.error, "capture failed")
        XCTAssertNil(response.rotation)
        XCTAssertNil(response.appWidth)
        XCTAssertNil(locator.gestureGeometry)
    }
}
