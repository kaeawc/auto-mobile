@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeStatusSafeAreaTests: XCTestCase {
    func testVisibleStatusBarReportsWindowTopInPoints() {
        XCTAssertEqual(prototypeStatusSafeAreaTop(
            windowInsets: PrototypeSafeInsets(top: 59, left: 0, bottom: 34, right: 0),
            statusBarHidden: false
        ), 59)
    }

    func testHiddenStatusBarReportsZeroEvenWithSafeArea() {
        XCTAssertEqual(prototypeStatusSafeAreaTop(
            windowInsets: PrototypeSafeInsets(top: 59), statusBarHidden: true
        ), 0)
    }

    func testMissingWindowReportsZero() {
        XCTAssertEqual(prototypeStatusSafeAreaTop(windowInsets: nil, statusBarHidden: false), 0)
    }

    func testZeroAndInvalidInsetsReportZero() {
        for top in [CGFloat(0), -1, .infinity, .nan] {
            XCTAssertEqual(prototypeStatusSafeAreaTop(
                windowInsets: PrototypeSafeInsets(top: top), statusBarHidden: false
            ), 0)
        }
    }
}
