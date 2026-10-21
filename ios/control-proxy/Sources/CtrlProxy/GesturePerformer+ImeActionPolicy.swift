import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    nonisolated static let submitButtonNames = [
        "return", "return_arrow", "returnarrow", "go", "search", "done", "next",
        "send", "join", "route", "↵", "⏎", "↩",
    ]
    nonisolated static let closeButtonNames = [
        "dismiss keyboard", "hide keyboard", "dismisskeyboard", "hidekeyboard",
    ] + submitButtonNames
    nonisolated static let multilineCloseError =
        "Keyboard did not close: the focused field is multiline and has no dismiss key; tap outside the field or use a different action"

    enum CloseAttempt: Equatable {
        case matchedButton
        case newline
        case escape
    }

    enum ImeFocusedField: Equatable, Sendable {
        case absent
        case singleLine
        case multiline
        case unresolved
    }

    enum ImeActionDecision: Equatable, Sendable {
        case tapKey(index: Int)
        case typeReturn
        case notAvailable(String)
    }

    /// Match the requested action exactly (case-insensitive) by label or identifier.
    /// A different action label, including plain Return, is not an IME action
    /// for a text view. Single-line and unresolved inputs retain the Return fallback,
    /// including focused inputs using a hardware keyboard.
    /// An explicitly disabled matching key must not be bypassed by that fallback.
    nonisolated static func imeActionDecision(
        action: String,
        focusedField: ImeFocusedField,
        keyboardVisible: Bool,
        keys: [(label: String, identifier: String, isEnabled: Bool)]
    )
        -> ImeActionDecision
    {
        let action = action.lowercased()
        guard ["done", "go", "search", "send", "next"].contains(action) else {
            return .notAvailable("IME action: \(action)")
        }
        if keyboardVisible {
            let matches = keys.indices.filter {
                keys[$0].label.lowercased() == action || keys[$0].identifier.lowercased() == action
            }
            if let index = matches.first(where: { keys[$0].isEnabled }) {
                return .tapKey(index: index)
            }
            if !matches.isEmpty {
                return .notAvailable("IME action '\(action)' is not available: the keyboard action key is disabled")
            }
        } else if focusedField == .absent {
            return .notAvailable(
                "IME action '\(action)' is not available: no keyboard is visible and no focused text field was found"
            )
        }
        if focusedField == .multiline {
            return .notAvailable(
                "IME action '\(action)' is not available for this multi-line field: Return would insert a line break"
            )
        }
        return .typeReturn
    }

    nonisolated static func closeAttemptOrder(
        hasEnabledMatch: Bool,
        hasSubmitKey: Bool,
        isMultiline: Bool
    )
        -> [CloseAttempt]
    {
        (hasEnabledMatch ? [.matchedButton] : []) + (!isMultiline && hasSubmitKey ? [.newline] : []) + [.escape]
    }

    nonisolated static func closeKeyCandidates(
        _ labels: [(label: String, identifier: String)],
        isMultiline: Bool = false
    )
        -> [(
            index: Int,
            method: String
        )]
    {
        let keys = labels.map { "\($0.label) \($0.identifier)".lowercased() }
        let dismiss = keys.indices.filter {
            keys[$0].contains("dismiss keyboard") || keys[$0].contains("hide keyboard") ||
                keys[$0].contains("dismisskeyboard") || keys[$0].contains("hidekeyboard")
        }.map { (index: $0, method: "dismissKey") }
        let returns = keys.indices.filter { index in
            let words = keys[index].components(separatedBy: CharacterSet.alphanumerics.inverted)
            let isSubmit = ["return", "go", "search", "done", "next", "send", "join", "route"].contains {
                words.contains($0)
            }
                || keys[index].contains("returnarrow")
                || ["↵", "⏎", "↩"].contains { keys[index].contains($0) }
            return !dismiss.contains(where: { $0.index == index }) && isSubmit
        }.map { (index: $0, method: "returnKey") }
        return dismiss + (isMultiline ? [] : returns)
    }
}
