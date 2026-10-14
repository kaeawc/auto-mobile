@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeAccessibilityGroupingTests: XCTestCase {
    func testCompositeContainersPreserveChildIdentifiersEvenWhenTappable() {
        for type in ["bottomSheet", "dialog", "snackbar", "radioGroup", "segmentedButton", "topAppBar", "searchBar"] {
            for tappable in [false, true] {
                XCTAssertEqual(prototypeAccessibilityGrouping(type: type, tappable: tappable), .contain, type)
            }
        }
    }

    func testLayoutContainersCombineOnlyWhenTappable() {
        for type in ["box", "row", "column", "scroll", "pager", "card"] {
            XCTAssertEqual(prototypeAccessibilityGrouping(type: type, tappable: false), .contain, type)
            XCTAssertEqual(prototypeAccessibilityGrouping(type: type, tappable: true), .combine, type)
        }
    }

    func testLeafControlsKeepTheirOwnIdentifiers() {
        for type in ["text", "button", "textField"] {
            for tappable in [false, true] {
                XCTAssertEqual(prototypeAccessibilityGrouping(type: type, tappable: tappable), .leaf, type)
            }
        }
    }
}
