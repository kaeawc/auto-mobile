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

    func testRecognizesSubmitLabelsAndIgnoresUnrelatedKeys() {
        let labels = ["Go", "Search", "Done", "Next", "Send", "Return", "Space", "Delete", "Google"]
        let candidates = GesturePerformer.closeKeyCandidates(labels.map { (label: $0, identifier: "") })
        XCTAssertEqual(candidates.map(\.index), [0, 1, 2, 3, 4, 5])
        XCTAssertTrue(candidates.allSatisfy { $0.method == "returnKey" })
    }

    func testNoFallbackWhenKeyboardHasNoDismissOrSubmitKey() {
        XCTAssertTrue(GesturePerformer.closeKeyCandidates([
            (label: "Space", identifier: ""),
            (label: "Delete", identifier: ""),
        ]).isEmpty)
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
