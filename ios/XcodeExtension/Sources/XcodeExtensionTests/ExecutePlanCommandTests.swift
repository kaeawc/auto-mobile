@testable import XcodeExtension
import XCTest

final class ExecutePlanCommandTests: XCTestCase {
    func testPlanContentErrorNilForNonEmptyPlan() {
        XCTAssertNil(ExecutePlanCommandLogic.planContentError("name: Test\nsteps:\n  - tool: observe"))
    }

    func testPlanContentErrorForEmptyBuffer() {
        let error = ExecutePlanCommandLogic.planContentError("")
        XCTAssertNotNil(error)
        XCTAssertEqual(error?.domain, "AutoMobile")
    }

    func testPlanContentErrorForWhitespaceOnlyBuffer() {
        XCTAssertNotNil(ExecutePlanCommandLogic.planContentError("   \n\t  \n"))
    }

    func testNotificationNameIsStable() {
        // The companion app subscribes to this exact name.
        XCTAssertEqual(ExecutePlanCommandLogic.notificationName, "com.automobile.execute-plan")
    }
}
