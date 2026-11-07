import XCTest

final class WatchAccessibilityLabelTests: XCTestCase {
    func testNonSecureFieldsPreferValueThenPlaceholder() {
        for type in [UInt(45), 49] {
            XCTAssertEqual(
                watchAccessibilityLabel(elementType: type, label: "", value: "helloAB", placeholder: "Text"),
                "helloAB"
            )
            XCTAssertEqual(
                watchAccessibilityLabel(elementType: type, label: "", value: "", placeholder: "Text"),
                "Text"
            )
            XCTAssertEqual(
                watchAccessibilityLabel(elementType: type, label: "", value: nil, placeholder: "Text"),
                "Text"
            )
            XCTAssertEqual(watchAccessibilityLabel(elementType: type, label: "", value: nil, placeholder: nil), "")
        }
    }

    func testSecureFieldsNeverUseValue() {
        for value in ["secret", "", nil] as [String?] {
            XCTAssertEqual(
                watchAccessibilityLabel(elementType: 50, label: "", value: value, placeholder: "Password"),
                "Password"
            )
            XCTAssertEqual(watchAccessibilityLabel(elementType: 50, label: "", value: value, placeholder: nil), "")
        }
    }

    func testExistingLabelsAndNonInputElementsArePreserved() {
        for type in [UInt(45), 49, 50, 48, 9] {
            XCTAssertEqual(
                watchAccessibilityLabel(elementType: type, label: "Label", value: "value", placeholder: "Text"),
                "Label"
            )
        }
        for type in [UInt(48), 9] {
            XCTAssertEqual(
                watchAccessibilityLabel(elementType: type, label: "", value: "value", placeholder: "Text"),
                ""
            )
        }
    }

    func testLabeledPopulatedTextFieldExposesValueChild() {
        for type in [UInt(45), 49] {
            XCTAssertEqual(watchTextValueChild(elementType: type, label: "Name", value: "helloAB"), "helloAB")
            XCTAssertNil(watchTextValueChild(elementType: type, label: "Name", value: ""))
            XCTAssertNil(watchTextValueChild(elementType: type, label: "Name", value: nil))
            XCTAssertNil(watchTextValueChild(elementType: type, label: "same", value: "same"))
            XCTAssertNil(watchTextValueChild(elementType: type, label: "", value: "helloAB"))
        }
    }

    func testSecureAndOtherElementsNeverExposeValueChild() {
        for type in [UInt(50), 48, 9] {
            XCTAssertNil(watchTextValueChild(elementType: type, label: "Password", value: "secret"))
        }
    }
}
