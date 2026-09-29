@testable import CtrlProxyRewrite
import XCTest

final class KeyboardCloseKeySelectionTests: XCTestCase {
    func testKeyboardResponseEncodesDismissalMethod() throws {
        let response = KeyboardResponse(
            requestId: "close",
            success: true,
            open: false,
            totalTimeMs: 1,
            method: "returnKey"
        )
        let decoded = try JSONDecoder().decode(KeyboardResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(decoded.method, "returnKey")
    }

    func testDismissKeyPrecedesReturnAcrossButtonsAndKeys() {
        let candidates = GesturePerformer.closeKeyCandidates([
            (label: "Search", identifier: ""),
            (label: "", identifier: "RETURN_ARROW"),
            (label: "Hide Keyboard", identifier: ""),
        ])
        XCTAssertEqual(candidates.map(\.index), [2, 0, 1])
        XCTAssertEqual(candidates.map(\.method), ["dismissKey", "returnKey", "returnKey"])
    }

    func testSingleLineCloseAttemptsTryEnabledButtonThenNewlineThenEscape() {
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: true, isMultiline: false),
            [.matchedButton, .newline, .escape]
        )
    }

    func testSingleLineCloseAttemptsSkipDisabledButtonBeforeNewlineAndEscape() {
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: false, isMultiline: false),
            [.newline, .escape]
        )
    }

    func testMultilineCloseAttemptsOnlyUseDismissButtonThenEscape() {
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: true, isMultiline: true),
            [.matchedButton, .escape]
        )
        let candidates = GesturePerformer.closeKeyCandidates([
            (label: "Return", identifier: ""),
            (label: "Hide Keyboard", identifier: ""),
        ], isMultiline: true)
        XCTAssertEqual(candidates.map(\.method), ["dismissKey"])
    }

    func testRecognizesSubmitLabelsAndIgnoresUnrelatedKeys() {
        let labels = [
            "Go",
            "Search",
            "Done",
            "Next",
            "Send",
            "Join",
            "Route",
            "Return",
            "↵",
            "⏎",
            "↩",
            "Space",
            "Delete",
            "Google",
        ]
        let candidates = GesturePerformer.closeKeyCandidates(labels.map { (label: $0, identifier: "") })
        XCTAssertEqual(candidates.map(\.index), Array(0 ... 10))
        XCTAssertTrue(candidates.allSatisfy { $0.method == "returnKey" })
    }

    func testMultilineNoFallbackWhenKeyboardHasNoDismissOrSubmitKey() {
        XCTAssertTrue(GesturePerformer.closeKeyCandidates([
            (label: "Space", identifier: ""),
            (label: "Delete", identifier: ""),
        ]).isEmpty)
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: false, isMultiline: true),
            [.escape]
        )
    }

    func testMultilineCloseErrorEncodesInKeyboardResponse() throws {
        let error =
            "Keyboard did not close: the focused field is multiline and has no dismiss key; tap outside the field or use a different action"
        let response = KeyboardResponse(requestId: "close", success: false, open: true, totalTimeMs: 1, error: error)
        let decoded = try JSONDecoder().decode(KeyboardResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(decoded.error, error)
    }

    func testClosePollRespectsAttemptAndOverallDeadlines() {
        XCTAssertEqual(GesturePerformer.closePollDelay(now: 1, attemptDeadline: 1.6, closeDeadline: 4.5) ?? -1, 0.1)
        XCTAssertEqual(
            GesturePerformer.closePollDelay(now: 1.55, attemptDeadline: 1.6, closeDeadline: 4.5) ?? -1,
            0.05,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            GesturePerformer.closePollDelay(now: 4.45, attemptDeadline: 5, closeDeadline: 4.5) ?? -1,
            0.05,
            accuracy: 0.0001
        )
        XCTAssertNil(GesturePerformer.closePollDelay(now: 1.6, attemptDeadline: 1.6, closeDeadline: 4.5))
        XCTAssertNil(GesturePerformer.closePollDelay(now: 4.5, attemptDeadline: 5, closeDeadline: 4.5))
    }
}

// Host-testable pure helpers of the rewrite's `@MainActor` `GesturePerformer`, mirroring
// `CtrlProxyTests.ClipboardResolutionTests` and `CtrlProxyTests.GesturePerformerSemanticLinkTests`.
// These statics are `nonisolated static` on the rewrite class specifically so a
// non-@MainActor `XCTestCase` can call them synchronously off the main actor; the reference
// left them plain statics on an un-isolated class. The clipboard-resolution and
// scoped-link-candidate logic is byte-for-byte the same, so the assertions are identical.

final class ClipboardResolutionTests: XCTestCase {
    func testGetReturnsLivePasteboardValueInsteadOfShadow() throws {
        let text = try GesturePerformer.resolveClipboardGet(
            readResult: .value("external")
        )

        XCTAssertEqual(text, "external")
    }

    func testGetReturnsEmptyWhenPasteboardHasNoStringInsteadOfShadow() throws {
        let text = try GesturePerformer.resolveClipboardGet(
            readResult: .empty
        )

        XCTAssertNil(text)
    }

    func testGetReturnsEmptyWhenLivePasteboardValueIsEmptyString() throws {
        let text = try GesturePerformer.resolveClipboardGet(
            readResult: .value("")
        )

        XCTAssertNil(text)
    }

    func testGetThrowsWhenLivePasteboardReadIsUnavailableInsteadOfReturningShadow() {
        XCTAssertThrowsError(try GesturePerformer.resolveClipboardGet(
            readResult: .unavailable
        )) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "Clipboard read unavailable; live pasteboard access may be restricted, so shadow clipboard content was not returned"
            )
        }
    }
}

final class GesturePerformerSemanticLinkTests: XCTestCase {
    func testScopedLinkCandidatesIncludesAnOwnerThatIsItselfALink() {
        XCTAssertEqual(
            GesturePerformer.scopedLinkCandidates(
                owner: "Terms of Service",
                ownerIsLink: true,
                descendants: ["Privacy Policy"]
            ),
            ["Terms of Service", "Privacy Policy"]
        )
    }

    func testScopedLinkCandidatesExcludesANonLinkOwner() {
        XCTAssertEqual(
            GesturePerformer.scopedLinkCandidates(
                owner: "Legal card",
                ownerIsLink: false,
                descendants: ["Terms of Service"]
            ),
            ["Terms of Service"]
        )
    }
}
