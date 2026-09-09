@testable import CtrlProxyRewrite
import XCTest

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
