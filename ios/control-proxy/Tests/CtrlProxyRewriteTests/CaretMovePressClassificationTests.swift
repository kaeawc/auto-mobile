@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class CaretMovePressClassificationTests: XCTestCase {
    func testTrueIsVerified() {
        XCTAssertEqual(classifyCaretMovePress(.success(true)), .verified)
    }

    func testFalseIsUnverifiedAfterSend() {
        XCTAssertEqual(classifyCaretMovePress(.success(false)), .unverifiedAfterSend)
    }

    func testNilIsFailure() {
        XCTAssertEqual(
            classifyCaretMovePress(.success(nil)),
            .failure(reason: "Unexpected nil verification for a plain arrow")
        )
    }

    func testBudgetExhaustedPreservesTypedReason() {
        let error = GesturePerformer.GestureError.arrowBudgetExhausted(step: "caret probe", elapsedMs: 4300)
        guard case let .failure(reason) = classifyCaretMovePress(.failure(error)) else {
            return XCTFail("A key not sent must fail")
        }
        XCTAssertEqual(reason, error.localizedDescription)
        XCTAssertTrue(reason.contains("runner time budget exhausted"))
    }

    func testArrowNoEffectPreservesTypedReason() {
        let error = GesturePerformer.GestureError.arrowNoEffect
        XCTAssertEqual(classifyCaretMovePress(.failure(error)), .failure(reason: error.localizedDescription))
    }

    func testGestureFailedPreservesTypedReason() {
        let error = GesturePerformer.GestureError.gestureFailed(
            "Forward delete unavailable: Right Arrow did not move the caret one character; use text replacement instead"
        )
        guard case let .failure(reason) = classifyCaretMovePress(.failure(error)) else {
            return XCTFail("A failed gesture must fail")
        }
        XCTAssertEqual(reason, error.localizedDescription)
        XCTAssertTrue(reason.contains("Forward delete unavailable"))
    }
}
