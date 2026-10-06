@testable import CtrlProxyRewrite
import XCTest

final class ConsumerButtonUsageTests: XCTestCase {
    func testConsumerButtonUsages() throws {
        XCTAssertEqual(try GesturePerformer.consumerUsage(for: "volume_up"), 0xE9)
        XCTAssertEqual(try GesturePerformer.consumerUsage(for: "volume_down"), 0xEA)
        XCTAssertEqual(try GesturePerformer.consumerUsage(for: "power"), 0x30)
        XCTAssertThrowsError(try GesturePerformer.consumerUsage(for: "menu"))
    }
}

final class ImeActionKeySelectionTests: XCTestCase {
    private let actions = ["send", "done", "go", "search", "next"]

    func testAllActionsTapMatchingKeyForSingleLineAndMultilineFields() {
        for action in actions {
            for focusedField in [GesturePerformer.ImeFocusedField.singleLine, .multiline] {
                XCTAssertEqual(
                    GesturePerformer.imeActionDecision(
                        action: action, focusedField: focusedField, keyboardVisible: true,
                        keys: [
                            (label: "Return", identifier: "", isEnabled: true),
                            (label: action.capitalized, identifier: "", isEnabled: true),
                        ]
                    ),
                    .tapKey(index: 1), "\(action), focusedField=\(focusedField)"
                )
            }
        }
    }

    func testAllActionsRejectPlainReturnForMultilineFields() {
        for action in actions {
            for returnName in ["Return", "return_arrow", "returnarrow", "↵", "⏎", "↩"] {
                XCTAssertEqual(
                    GesturePerformer.imeActionDecision(
                        action: action, focusedField: .multiline, keyboardVisible: true,
                        keys: [(label: returnName, identifier: "", isEnabled: true)]
                    ),
                    .notAvailable(
                        "IME action '\(action)' is not available for this multi-line field: Return would insert a line break"
                    )
                )
            }
        }
    }

    func testAllActionsKeepSingleLineReturnFallback() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .singleLine, keyboardVisible: true,
                    keys: [(label: "Return", identifier: "", isEnabled: true)]
                ),
                .typeReturn
            )
        }
    }

    func testNoSoftwareKeyboardKeepsSingleLineReturnFallback() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .singleLine, keyboardVisible: false, keys: []
                ),
                .typeReturn
            )
        }
    }

    func testNoSoftwareKeyboardRejectsMultilineReturn() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .multiline, keyboardVisible: false, keys: []
                ),
                .notAvailable(
                    "IME action '\(action)' is not available for this multi-line field: Return would insert a line break"
                )
            )
        }
    }

    func testNoSoftwareKeyboardAndNoFocusedFieldRejectsAllActions() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .absent, keyboardVisible: false, keys: []
                ),
                .notAvailable(
                    "IME action '\(action)' is not available: no keyboard is visible and no focused text field was found"
                )
            )
        }
    }

    func testNoSoftwareKeyboardIgnoresMatchingKeys() {
        for action in actions {
            let keys = [(label: action, identifier: "", isEnabled: true)]
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .singleLine, keyboardVisible: false, keys: keys
                ),
                .typeReturn
            )
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .multiline, keyboardVisible: false, keys: keys
                ),
                .notAvailable(
                    "IME action '\(action)' is not available for this multi-line field: Return would insert a line break"
                )
            )
        }
    }

    func testVisibleKeyboardWithUnresolvedFocusKeepsReturnFallback() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .unresolved, keyboardVisible: true,
                    keys: [(label: "Return", identifier: "", isEnabled: true)]
                ),
                .typeReturn
            )
        }
    }

    func testVisibleKeyboardWithUnresolvedFocusTapsMatchingKey() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .unresolved, keyboardVisible: true,
                    keys: [
                        (label: "Return", identifier: "", isEnabled: true),
                        (label: action, identifier: "", isEnabled: true),
                    ]
                ),
                .tapKey(index: 1)
            )
        }
    }

    func testVisibleKeyboardWithUnresolvedFocusRejectsDisabledMatchingKey() {
        for action in actions {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .unresolved, keyboardVisible: true,
                    keys: [
                        (label: action, identifier: "", isEnabled: false),
                        (label: "Return", identifier: "", isEnabled: true),
                    ]
                ),
                .notAvailable("IME action '\(action)' is not available: the keyboard action key is disabled")
            )
        }
    }

    func testMismatchedActionLabelsDoNotSubmitMultilineFields() {
        for action in actions {
            let keys = actions.filter { $0 != action }.map { (label: $0, identifier: "", isEnabled: true) }
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .multiline, keyboardVisible: true, keys: keys
                ),
                .notAvailable(
                    "IME action '\(action)' is not available for this multi-line field: Return would insert a line break"
                )
            )
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .singleLine, keyboardVisible: true, keys: keys
                ),
                .typeReturn
            )
        }
    }

    func testActionLabelAndIdentifierAreCaseInsensitive() {
        for action in actions {
            for key in [
                (label: action.uppercased(), identifier: "", isEnabled: true),
                (label: "", identifier: action.uppercased(), isEnabled: true),
                (label: "Return", identifier: action.uppercased(), isEnabled: true),
            ] {
                XCTAssertEqual(
                    GesturePerformer.imeActionDecision(
                        action: action.capitalized, focusedField: .multiline, keyboardVisible: true, keys: [key]
                    ),
                    .tapKey(index: 0)
                )
            }
        }
    }

    func testDisabledMatchingKeyCannotBeBypassedByReturn() {
        for action in actions {
            for focusedField in [GesturePerformer.ImeFocusedField.singleLine, .multiline] {
                XCTAssertEqual(
                    GesturePerformer.imeActionDecision(
                        action: action, focusedField: focusedField, keyboardVisible: true,
                        keys: [
                            (label: action, identifier: "", isEnabled: false),
                            (label: "Return", identifier: "", isEnabled: true),
                        ]
                    ),
                    .notAvailable("IME action '\(action)' is not available: the keyboard action key is disabled")
                )
            }
        }
    }

    func testEnabledMatchingKeyWinsOverDisabledDuplicate() {
        XCTAssertEqual(
            GesturePerformer.imeActionDecision(
                action: "send", focusedField: .multiline, keyboardVisible: true,
                keys: [
                    (label: "Send", identifier: "", isEnabled: false),
                    (label: "", identifier: "send", isEnabled: true),
                ]
            ),
            .tapKey(index: 1)
        )
    }

    func testNoRecognizedKeysOnlyAllowsSingleLineFallback() {
        for keys in [[], [(label: "Google", identifier: "sender", isEnabled: true)]] {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: "go", focusedField: .singleLine, keyboardVisible: true, keys: keys
                ),
                .typeReturn
            )
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: "go", focusedField: .multiline, keyboardVisible: true, keys: keys
                ),
                .notAvailable(
                    "IME action 'go' is not available for this multi-line field: Return would insert a line break"
                )
            )
        }
    }

    func testUnsupportedActionsDoNotTypeReturn() {
        for action in ["previous", "return", "unknown"] {
            XCTAssertEqual(
                GesturePerformer.imeActionDecision(
                    action: action, focusedField: .singleLine, keyboardVisible: true, keys: []
                ),
                .notAvailable("IME action: \(action)")
            )
        }
    }
}

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
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: true, hasSubmitKey: true, isMultiline: false),
            [.matchedButton, .newline, .escape]
        )
    }

    func testSingleLineDisabledGoKeyAllowsNewlineFallback() {
        let candidates = GesturePerformer.closeKeyCandidates([(label: "Go", identifier: "")])
        XCTAssertEqual(candidates.map(\.method), ["returnKey"])
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: false, hasSubmitKey: true, isMultiline: false),
            [.newline, .escape]
        )
    }

    func testSingleLineWithoutSubmitKeyOnlyTriesEscape() {
        XCTAssertTrue(GesturePerformer.closeKeyCandidates([(label: "Space", identifier: "")]).isEmpty)
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: false, hasSubmitKey: false, isMultiline: false),
            [.escape]
        )
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: true, hasSubmitKey: false, isMultiline: false),
            [.matchedButton, .escape]
        )
    }

    func testMultilineCloseAttemptsOnlyUseDismissButtonThenEscape() {
        XCTAssertEqual(
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: true, hasSubmitKey: true, isMultiline: true),
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
            GesturePerformer.closeAttemptOrder(hasEnabledMatch: false, hasSubmitKey: false, isMultiline: true),
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

    // MARK: - paste (#10083)

    func testPasteProceedsWhenLivePasteboardReadIsUnavailable() {
        // Unavailable is only reachable after `hasStrings` was true, so the pasteboard is non-empty.
        XCTAssertNoThrow(try GesturePerformer.resolveClipboardPaste(readResult: .unavailable))
    }

    func testPasteProceedsWhenLivePasteboardHasText() {
        XCTAssertNoThrow(try GesturePerformer.resolveClipboardPaste(readResult: .value("external")))
    }

    func testPasteIsRefusedAsEmptyWhenPasteboardHasNoString() {
        XCTAssertThrowsError(try GesturePerformer.resolveClipboardPaste(readResult: .empty)) { error in
            XCTAssertEqual(error.localizedDescription, "Clipboard is empty")
        }
    }

    func testPasteIsRefusedAsEmptyWhenLivePasteboardValueIsEmptyString() {
        XCTAssertThrowsError(try GesturePerformer.resolveClipboardPaste(readResult: .value(""))) { error in
            XCTAssertEqual(error.localizedDescription, "Clipboard is empty")
        }
    }
}

final class GesturePerformerSemanticLinkTests: XCTestCase {
    func testFallbackOccurrenceRequiresOwnerAboveZero() throws {
        XCTAssertNoThrow(try GesturePerformer.validateSemanticLinkFallback(occurrence: 0, ownerResourceId: nil))
        for occurrence in [0, 1, 2] {
            XCTAssertNoThrow(try GesturePerformer.validateSemanticLinkFallback(
                occurrence: occurrence, ownerResourceId: "owner"
            ))
        }
        for occurrence in [1, 2] {
            XCTAssertThrowsError(try GesturePerformer.validateSemanticLinkFallback(
                occurrence: occurrence, ownerResourceId: nil
            )) { error in
                guard case let GesturePerformer.GestureError.gestureFailed(message) = error else {
                    XCTFail("Expected typed gestureFailed error, got \(error)")
                    return
                }
                XCTAssertTrue(message.contains("occurrence > 0 needs an owner"))
                XCTAssertTrue(message.contains("container/subtext"))
            }
        }
    }

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
