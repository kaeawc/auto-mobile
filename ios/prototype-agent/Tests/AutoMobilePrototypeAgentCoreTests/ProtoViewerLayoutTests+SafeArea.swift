@testable import AutoMobilePrototypeAgentCore
import XCTest

extension ProtoViewerLayoutTests {
    func testPrototypeContentIgnoresOnlyTheBottomContainerSafeArea() {
        XCTAssertTrue(ProtoViewerContentLayout.ignoresBottomContainerSafeArea)
    }
}
