@testable import CtrlProxyRewrite
import Foundation
import XCTest

private actor FakeHingeAngleSetter: HingeAngleSetting {
    private var angles: [Double] = []
    private let failure: HingeAngleError?

    init(failure: HingeAngleError? = nil) {
        self.failure = failure
    }

    func setHingeAngle(_ degrees: Double) throws {
        angles.append(degrees)
        if let failure { throw failure }
    }

    func calls() -> [Double] { angles }
}

@MainActor
final class SetHingeAngleCommandTests: XCTestCase {
    private func handler(setter: FakeHingeAngleSetter) -> CommandHandler {
        CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            hingeAngleSetter: setter
        )
    }

    func testDecodesAndSetsAngle() async throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"set_hinge_angle","requestId":"r1","angle":180}"#.utf8
        ))
        let setter = FakeHingeAngleSetter()
        let result = await handler(setter: setter).handle(request)
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertEqual(response.type, "hinge_angle_result")
        XCTAssertEqual(response.requestId, "r1")
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.angle, 180)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [180])
    }

    func testRejectsOutOfRangeWithoutSetterCall() async throws {
        let setter = FakeHingeAngleSetter()
        let result = await handler(setter: setter).handle(
            .setHingeAngle(RequestSetHingeAngle(requestId: "r2", angle: 181))
        )
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertFalse(response.success)
        XCTAssertNotNil(response.error)
        let calls = await setter.calls()
        XCTAssertEqual(calls, [])
    }

    func testSetterFailureIsTypedResult() async throws {
        let setter = FakeHingeAngleSetter(failure: .dispatchFailed)
        let result = await handler(setter: setter).handle(
            .setHingeAngle(RequestSetHingeAngle(requestId: "r3", angle: 130))
        )
        let response = try XCTUnwrap(result as? HingeAngleResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, HingeAngleError.dispatchFailed.localizedDescription)
        XCTAssertNil(response.angle)
    }
}
