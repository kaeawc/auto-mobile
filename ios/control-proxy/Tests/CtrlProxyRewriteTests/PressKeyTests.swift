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
        gestures.keyError = .executionFailed("No focus")
        let failedResult = await handler.handle(request)
        let failure = try XCTUnwrap(failedResult as? WebSocketResponse)
        XCTAssertEqual(failure.success, false)
        XCTAssertEqual(failure.type, "press_key_result")
        XCTAssertEqual(failure.requestId, "key-1")
        XCTAssertEqual(gestures.keyCalls.count, 1)
    }
}
