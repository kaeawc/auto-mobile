import Foundation

// Independent of XCTest so the window-app boundary is testable on macOS.
enum VisionCommandPolicy {
    static let supportedCommands = [
        "request_hierarchy", "request_tap_element", "request_append_text",
    ]

    static func supports(_ command: String) -> Bool {
        supportedCommands.contains(command)
    }

    /// An app launched before XCTest may lack an accessible main window until relaunched.
    static func shouldRelaunchForSnapshotError(_ description: String) -> Bool {
        description.contains("kAXErrorAPIDisabled")
    }

    /// Keyboard-key sequences `typeText` interprets as deletion (XCUIKeyboardKey.delete is U+0008
    /// on iOS-family platforms and U+007F on macOS; forwardDelete is U+F728). Append-only text
    /// must not erase content already in the field.
    static let deleteKeySequences: [Character] = ["\u{8}", "\u{7F}", "\u{F728}"]

    static func containsDeleteKey(_ text: String) -> Bool {
        text.contains { deleteKeySequences.contains($0) }
    }

    struct TapCandidate {
        let elementType: UInt
        let label: String
        let isEnabled: Bool
    }

    enum TapResolution: Equatable {
        case match(Int)
        /// No candidate has the identifier with the supplied type/label.
        case missing
        /// Candidates match the identifier, type and label, but none is enabled.
        case disabled
        case ambiguous(Int)
    }

    /// Indices refer to the original identifier query, so the router taps the snapshotted element.
    static func tapResolution(
        candidates: [TapCandidate], label: String? = nil, elementType: UInt? = nil
    ) -> TapResolution {
        let selected = candidates.indices.filter { index in
            let candidate = candidates[index]
            return (label == nil || candidate.label == label)
                && (elementType == nil || candidate.elementType == elementType)
        }
        let matches = selected.filter { candidates[$0].isEnabled }
        if matches.count == 1 { return .match(matches[0]) }
        if matches.isEmpty { return selected.isEmpty ? .missing : .disabled }
        return .ambiguous(matches.count)
    }

    enum TypingTarget: Equatable {
        case focused
        case lastTapped
        case none
    }

    /// Picks the field text is appended to. `hasFocus` is not always set on the field a tap just
    /// activated, so when nothing reports focus the single text input the last `tapOn` hit is used.
    /// Several focused fields stay ambiguous: guessing could type into the wrong one.
    static func typingTarget(focusedCount: Int, lastTappedTextInputCount: Int) -> TypingTarget {
        if focusedCount == 1 { return .focused }
        if focusedCount == 0, lastTappedTextInputCount == 1 { return .lastTapped }
        return .none
    }

    /// The window app under automation: the daemon-supplied bundle id, else nil (demo app).
    static func targetBundleId(environment: [String: String]) -> String? {
        guard let value = environment["AM_BUNDLE_ID"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty
        else {
            return nil
        }
        return value
    }
}

/// Interaction metadata the shared observe/tapOn logic reads, derived from a coarse element kind.
enum VisionElementKind {
    case button
    case textInput
    case secureTextInput
    case other
}

struct VisionElementTraits: Equatable {
    let clickable: String?
    let focusable: String?
    let actions: [String]?
    /// Whether the entered value may be reported (never for secure fields).
    let exposesValue: Bool

    // Mirrors the iOS projection: only "true" is emitted, and disabled elements are inert.
    static func traits(for kind: VisionElementKind, isEnabled: Bool) -> VisionElementTraits {
        switch kind {
        case .button:
            return VisionElementTraits(
                clickable: isEnabled ? "true" : nil, focusable: nil, actions: nil, exposesValue: false
            )
        case .textInput, .secureTextInput:
            return VisionElementTraits(
                clickable: isEnabled ? "true" : nil,
                focusable: isEnabled ? "true" : nil,
                actions: isEnabled ? ["set_text", "clear_text"] : nil,
                exposesValue: kind == .textInput
            )
        case .other:
            return VisionElementTraits(clickable: nil, focusable: nil, actions: nil, exposesValue: false)
        }
    }

    /// The entered text when it differs from the placeholder and may be exposed. A field whose
    /// accessibility label equals what the user typed still reports it.
    func enteredValue(_ raw: Any?, placeholder: String?) -> String? {
        guard exposesValue, let text = raw as? String, !text.isEmpty, text != placeholder else {
            return nil
        }
        return text
    }
}
