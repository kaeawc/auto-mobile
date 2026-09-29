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

final class GesturePerformerFocusDiagnosticTests: XCTestCase {
    func testSnapshotFocusRequiresKeyboardForTextLikeWrapper() {
        XCTAssertFalse(GesturePerformer.acceptSnapshotFocus(
            keyboardVisible: false, focusedElementType: .other
        ))
        XCTAssertTrue(GesturePerformer.acceptSnapshotFocus(
            keyboardVisible: true, focusedElementType: .other
        ))
    }

    func testSnapshotFocusAcceptsRealEditableInputsWithoutSoftwareKeyboard() {
        for type in [
            GesturePerformer.SnapshotFocusElementType.textField,
            .secureTextField,
            .searchField,
            .textView,
        ] {
            XCTAssertTrue(GesturePerformer.acceptSnapshotFocus(
                keyboardVisible: false, focusedElementType: type
            ))
        }
    }

    func testDiagnosticStopsAfterNodeCap() {
        struct Node {
            let isEditable: Bool
            let children: [Int]
        }
        let nodes = [Node(isEditable: false, children: Array(1 ... 201))]
            + (1 ... 201).map { Node(isEditable: $0 == 201, children: []) }
        let summary = GesturePerformer.boundedFocusDiagnostic(
            root: 0,
            children: { nodes[$0].children },
            describe: { index in
                guard nodes[index].isEditable else { return nil }
                return GesturePerformer.FocusDiagnosticEntry(
                    kind: "textFields", identifier: "beyond-cap", hasFocus: true,
                    isSelected: false, valueLength: 0, frame: .zero
                )
            }
        )
        XCTAssertEqual(summary.visitedNodes, 200)
        XCTAssertTrue(summary.truncated)
        XCTAssertEqual(summary.counts["textFields", default: 0], 0)
    }
}
