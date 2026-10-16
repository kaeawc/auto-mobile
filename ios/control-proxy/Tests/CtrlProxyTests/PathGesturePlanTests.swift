@testable import CtrlProxy
import XCTest

final class PathGesturePlanTests: XCTestCase {
    private func point(_ x: Double, _ y: Double, _ offsetMs: Int) -> PathGesturePoint {
        PathGesturePoint(x: x, y: y, offsetMs: offsetMs)
    }

    private func assertInvalid(_ points: [PathGesturePoint], contains text: String, line: UInt = #line) {
        XCTAssertThrowsError(try PathGesturePlan.validate(points), line: line) { error in
            XCTAssertTrue("\(error)".contains(text) || error.localizedDescription.contains(text), "\(error)", line: line)
        }
    }

    func testAcceptsAHoldThenMoveTimeline() throws {
        let points = [point(1, 2, 0), point(1, 2, 300), point(5, 9, 600)]
        XCTAssertEqual(try PathGesturePlan.validate(points), points)
    }

    func testRejectsTooFewPoints() {
        assertInvalid([point(1, 2, 0)], contains: "at least 2 points")
    }

    func testRejectsTooManyPoints() {
        let points = (0 ... PathGesturePlan.maxPoints).map { point(Double($0), 0, $0) }
        assertInvalid(points, contains: "at most")
    }

    func testRequiresTheFirstOffsetToBeZero() {
        assertInvalid([point(0, 0, 10), point(1, 1, 20)], contains: "must be 0")
    }

    func testRejectsDecreasingOffsets() {
        assertInvalid([point(0, 0, 0), point(1, 1, 100), point(2, 2, 50)], contains: "must not decrease")
    }

    func testAllowsEqualOffsets() throws {
        XCTAssertNoThrow(try PathGesturePlan.validate([point(0, 0, 0), point(1, 1, 0)]))
    }

    func testRejectsNonFiniteCoordinates() {
        assertInvalid([point(0, 0, 0), point(.nan, 1, 10)], contains: "finite")
        assertInvalid([point(0, 0, 0), point(1, .infinity, 10)], contains: "finite")
    }

    func testRejectsADurationOverTheCap() {
        assertInvalid(
            [point(0, 0, 0), point(1, 1, PathGesturePlan.maxDurationMs + 1)],
            contains: "exceeds"
        )
        XCTAssertNoThrow(try PathGesturePlan.validate([point(0, 0, 0), point(1, 1, PathGesturePlan.maxDurationMs)]))
    }

    func testRequestDecodesFromTheWireShape() throws {
        let json = #"{"type":"request_path_gesture","requestId":"r","points":[{"x":1,"y":2,"offsetMs":0},{"x":3,"y":4,"offsetMs":250}]}"#
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
        guard case let .pathGesture(payload) = request else { return XCTFail("decoded \(request)") }
        XCTAssertEqual(payload.points, [point(1, 2, 0), point(3, 4, 250)])
        XCTAssertEqual(request.typeString, "request_path_gesture")
        XCTAssertEqual(RequestType.requestPathGesture.responseType, .pathGestureResult)
    }
}
