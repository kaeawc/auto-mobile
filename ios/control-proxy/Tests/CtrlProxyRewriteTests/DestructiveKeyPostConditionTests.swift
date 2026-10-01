@testable import CtrlProxyRewrite
import XCTest

final class DestructiveKeyPostConditionTests: XCTestCase {
    func testClassifierAndDecisionMatrix() {
        let reliable: [GesturePerformer.FocusedElementKind] = [
            .textField, .secureTextField, .textView, .searchField,
        ]
        XCTAssertEqual(reliable.count + 2, GesturePerformer.FocusedElementKind.allCases.count)
        for kind in reliable {
            XCTAssertEqual(GesturePerformer.focusedValueReliability(for: kind), .reliable)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "abcd", after: "abc"
            ), .delivered)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "abcd", after: "abcd"
            ), .failed)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "abcd", after: "abce"
            ), .failed)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "", after: ""
            ), .boundaryNoOp)
        }
        XCTAssertEqual(GesturePerformer.focusedValueReliability(for: .other), .other)
        XCTAssertEqual(GesturePerformer.focusedValueReliability(for: .unsupported), .unreliable)
        for kind in [GesturePerformer.FocusedElementKind.other, .unsupported] {
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "abcd", after: "abc"
            ), .delivered)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "abcd", after: "abcd"
            ), .deliveredWithWarning)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "abcd", after: "abce"
            ), .delivered)
            XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
                kind: kind, before: "", after: ""
            ), .boundaryNoOp)
        }
    }

    func testSecureMaskedValueTracksDeletionByLength() {
        XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
            kind: .secureTextField, before: "••••", after: "•••"
        ), .delivered)
        XCTAssertEqual(GesturePerformer.destructiveKeyPostCondition(
            kind: .secureTextField, before: "••••", after: "••••"
        ), .failed)
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "••••", after: "•••"), .deleted)
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "••••", after: "••••"), .noEffect)
    }

    func testWarningExplainsUnconfirmedDelivery() {
        let warning = GesturePerformer.destructiveKeyWarning(key: "backspace")
        XCTAssertTrue(warning.contains("backspace"))
        XCTAssertTrue(warning.contains("value did not change"))
        XCTAssertTrue(warning.contains("element type does not reliably reflect edits"))
        XCTAssertTrue(warning.contains("delivery could not be confirmed"))
    }
}
