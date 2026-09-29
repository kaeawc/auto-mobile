@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class PressKeyTests: XCTestCase {
    func testFocusedEmptyOtherIsEligibleForKeyPressButNotTextInputDetection() {
        XCTAssertTrue(GesturePerformer.isFocusedSnapshotCandidate(
            hasFocus: true, isKnownTextInput: false, isOther: true,
            hasTextInputEvidence: false, forKeyPress: true
        ))
        XCTAssertFalse(GesturePerformer.isFocusedSnapshotCandidate(
            hasFocus: true, isKnownTextInput: false, isOther: true,
            hasTextInputEvidence: false, forKeyPress: false
        ))
        XCTAssertFalse(GesturePerformer.isFocusedSnapshotCandidate(
            hasFocus: false, isKnownTextInput: false, isOther: true,
            hasTextInputEvidence: false, forKeyPress: true
        ))
    }

    func testDestructiveKeyRequiresObservableFieldAndAcceptsSelectionDeletion() {
        XCTAssertFalse(GesturePerformer.canVerifyDestructiveKey(focusedValue: nil))
        XCTAssertTrue(GesturePerformer.canVerifyDestructiveKey(focusedValue: ""))
        XCTAssertTrue(GesturePerformer.didDeleteText(before: "hello", after: "hel"))
        XCTAssertFalse(GesturePerformer.didDeleteText(before: "hello", after: "hello"))
        XCTAssertFalse(GesturePerformer.didDeleteText(before: "hello", after: "helloo"))
    }

    func testForwardDeleteMarkerSelectionFailsClosedWhenCandidatesAreUsed() {
        XCTAssertEqual(GesturePerformer.forwardDeleteMarker(for: "hello"), "\u{E000}")
        XCTAssertEqual(GesturePerformer.forwardDeleteMarker(for: "h\u{E000}ello"), "\u{E001}")
        let allMarkers = (0xE000 ... 0xE007).compactMap(UnicodeScalar.init).map(String.init).joined()
        XCTAssertNil(GesturePerformer.forwardDeleteMarker(for: allMarkers))
    }

    func testForwardDeleteProbeFindsCaretAndRejectsUntrustedValues() {
        let marker = "\u{E000}"
        XCTAssertEqual(
            GesturePerformer.forwardDeleteMarkerIndex(original: "hello", probed: "hell\(marker)o", marker: marker),
            4
        )
        XCTAssertEqual(
            GesturePerformer.forwardDeleteMarkerIndex(original: "hello", probed: "hello\(marker)", marker: marker),
            5
        )
        XCTAssertNil(GesturePerformer.forwardDeleteMarkerIndex(
            original: "hello",
            probed: "hell\(marker)O",
            marker: marker
        ))
        XCTAssertNil(GesturePerformer.forwardDeleteMarkerIndex(
            original: "hello",
            probed: "hell\(marker)\(marker)o",
            marker: marker
        ))
        XCTAssertNil(GesturePerformer.forwardDeleteMarkerIndex(original: "hello", probed: "hello", marker: marker))
        XCTAssertTrue(GesturePerformer.caretHasFollowingCharacter(markerIndex: 4, originalLength: 5))
        XCTAssertFalse(GesturePerformer.caretHasFollowingCharacter(markerIndex: 5, originalLength: 5))
        XCTAssertFalse(GesturePerformer.caretHasFollowingCharacter(markerIndex: 0, originalLength: 0))
    }

    func testHorizontalArrowOutcomeRejectsChangedValueBeforeConsideringCaret() {
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "←abc", before: 0, after: 0
        ), .valueChanged)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc→", before: 1, after: 2
        ), .valueChanged)
    }

    func testHorizontalArrowOutcomeRequiresMovementInTheRequestedDirection() {
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: 3, after: 2
        ), .moved)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 1, after: 2
        ), .moved)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: 2, after: 2
        ), .noEffect)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 1, after: 1
        ), .noEffect)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 2, after: 1
        ), .wrongDirection)
    }

    func testHorizontalArrowOutcomeAcceptsOnlyUnchangedBoundaryNoOps() {
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: 0, after: 0
        ), .boundaryNoOp)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 3, after: 3
        ), .boundaryNoOp)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "", observed: "", before: 0, after: 0
        ), .boundaryNoOp)
    }

    func testHorizontalArrowOutcomeIsUnverifiedWithoutCaretProbe() {
        XCTAssertNil(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: nil, after: nil
        ))
        XCTAssertNil(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 1, after: nil
        ))
    }

    func testHorizontalArrowNoEffectUsesExactActionableMessage() {
        XCTAssertEqual(
            GesturePerformer.GestureError.arrowNoEffect.localizedDescription,
            "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead"
        )
    }

    func testDecodePreservesKeyAndModifiersAndResponseType() throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_press_key","requestId":"key-1","key":"tab","modifiers":["shift","meta"]}"#.utf8
        ))
        guard case let .pressKey(payload) = request else { return XCTFail("Expected pressKey") }
        XCTAssertEqual(payload.key, "tab")
        XCTAssertEqual(payload.modifiers, ["shift", "meta"])
        XCTAssertEqual(payload.requestId, "key-1")
        XCTAssertEqual(request.requestType, .requestPressKey)
        XCTAssertEqual(RequestType.requestPressKey.responseType, .pressKeyResult)
    }
}

@MainActor
final class PressKeyDispatchTests: XCTestCase {
    func testPressKeyForwardsModifiersAndPreservesFailure() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let request = WebSocketRequest.pressKey(RequestPressKey(
            requestId: "key-1", key: "tab", modifiers: ["shift", "meta"]
        ))
        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "press_key_result")
        XCTAssertEqual(response.requestId, "key-1")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.keyCalls.count, 1)
        XCTAssertEqual(gestures.keyCalls.first?.0, "tab")
        XCTAssertEqual(gestures.keyCalls.first?.1, ["shift", "meta"])
        gestures.keyVerified = false
        let unverifiedResult = await handler.handle(request)
        let unverified = try XCTUnwrap(unverifiedResult as? WebSocketResponse)
        XCTAssertEqual(unverified.success, true)
        XCTAssertEqual(unverified.verified, false)
        gestures.keyError = .executionFailed("No focus")
        let failedResult = await handler.handle(request)
        let failure = try XCTUnwrap(failedResult as? WebSocketResponse)
        XCTAssertEqual(failure.success, false)
        XCTAssertEqual(failure.type, "press_key_result")
        XCTAssertEqual(failure.requestId, "key-1")
        XCTAssertEqual(gestures.keyCalls.count, 2)
    }
}
