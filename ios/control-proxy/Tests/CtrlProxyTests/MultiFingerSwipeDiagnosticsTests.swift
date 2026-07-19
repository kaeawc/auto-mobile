import XCTest

@testable import CtrlProxy

/// Unit tests for the multi-finger-swipe failure-message split.
///
/// `multiFingerSwipe` has no public-API fallback (see `MultiFingerSwipeDiagnostics`
/// for why), so the `symbolsUnavailable` signal from the ObjC bridge is spent on
/// telling the two failure modes apart in the message the client sees. The real
/// `GesturePerformer.multiFingerSwipe` synthesis path is device-only, so the
/// message selection is extracted here to be verifiable off-device — the same
/// pattern `PinchFallback` uses. See issue #2952.
final class MultiFingerSwipeDiagnosticsTests: XCTestCase {

    func testUnavailableAndSynthesisFailureProduceDistinctMessages() {
        let unavailable = MultiFingerSwipeDiagnostics.failureMessage(
            symbolsUnavailable: true,
            underlying: "boom"
        )
        let genuine = MultiFingerSwipeDiagnostics.failureMessage(
            symbolsUnavailable: false,
            underlying: "boom"
        )
        XCTAssertNotEqual(
            unavailable,
            genuine,
            "an availability gap must not be conflated with a genuine synthesis error"
        )
    }

    func testUnavailableMessageNamesThePrivateSymbolGapAndTheLackOfFallback() {
        let message = MultiFingerSwipeDiagnostics.failureMessage(
            symbolsUnavailable: true,
            underlying: "XCPointerEventPath does not support the expected multi-touch selectors"
        )
        // Actionable: says what is missing and that the gesture cannot degrade,
        // so a caller knows this is an OS/XCTest gap and not a bad request.
        XCTAssertTrue(
            message.contains("private XCTest"),
            "must name the private-symbol gap, got: \(message)"
        )
        XCTAssertTrue(
            message.contains("no public"),
            "must state that no public fallback exists, got: \(message)"
        )
    }

    /// This string is the third segment of a stacked message (`GestureError`
    /// prepends "Gesture failed: ", the TS layer prepends "iOS multi-finger gesture
    /// failed: "), and long error text costs agent context. Keep the framing tight
    /// and single-line so it renders cleanly in a JSON error field.
    func testUnavailableMessageStaysCompactAndSingleLine() {
        let message = MultiFingerSwipeDiagnostics.failureMessage(
            symbolsUnavailable: true,
            underlying: ""
        )
        XCTAssertFalse(message.contains("\n"), "must be single-line on the wire")
        XCTAssertFalse(message.contains("  "), "must not contain doubled spaces")
        XCTAssertLessThanOrEqual(
            message.count,
            160,
            "framing must stay compact, got \(message.count) chars: \(message)"
        )
    }

    func testBothBranchesPreserveTheUnderlyingDetail() {
        let detail = "multi-finger swipe synthesis failed: unknown error"
        XCTAssertTrue(
            MultiFingerSwipeDiagnostics.failureMessage(symbolsUnavailable: true, underlying: detail)
                .contains(detail),
            "the availability message must keep the bridge's detail"
        )
        XCTAssertTrue(
            MultiFingerSwipeDiagnostics.failureMessage(symbolsUnavailable: false, underlying: detail)
                .contains(detail),
            "the synthesis-error message must keep the bridge's detail"
        )
    }

    func testGenuineFailurePassesTheUnderlyingDetailThroughUnchanged() {
        // A real synthesis error is already descriptive; do not bury it in
        // availability framing that would misdirect the reader.
        let detail = "multi-finger swipe synthesis failed: touch delivery timed out"
        XCTAssertEqual(
            MultiFingerSwipeDiagnostics.failureMessage(symbolsUnavailable: false, underlying: detail),
            detail
        )
    }
}
