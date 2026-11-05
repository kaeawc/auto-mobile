import Foundation

// Independent of XCTest so the window-app boundary is testable on macOS.
enum VisionCommandPolicy {
    static let supportedCommands = [
        "request_hierarchy", "request_tap_element", "request_append_text",
    ]

    static func supports(_ command: String) -> Bool {
        supportedCommands.contains(command)
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

    /// The entered text when it differs from the label (placeholder) and may be exposed.
    func enteredValue(_ raw: Any?, label: String) -> String? {
        guard exposesValue, let text = raw as? String, !text.isEmpty, text != label else {
            return nil
        }
        return text
    }
}
