import Foundation

// Kept independent of XCTest and UIKit so macOS SwiftPM tests cover the capability boundary.
enum TVCommandPolicy {
    static let supportedCommands = [
        "request_hierarchy", "request_press_button", "request_append_text", "request_screenshot",
    ]

    static func supports(_ command: String) -> Bool {
        supportedCommands.contains(command)
    }
}

enum TVRemoteButton: String, CaseIterable {
    case moveUp = "up"
    case down, left, right, select, menu, home, playPause
}

enum TVElementText {
    static func text(
        label: String, value: String?, placeholder: String? = nil, isTextInput: Bool, isSecure: Bool
    ) -> String {
        guard !isSecure, isTextInput, let value, !value.isEmpty,
              value != placeholder else { return label }
        // Emit the value alone for an empty or matching label; otherwise join label and value with one space.
        return label.isEmpty || label == value ? value : "\(label) \(value)"
    }
}

enum TVSecureField {
    static func isSecure(elementType: Int, identifier: String, label: String, placeholder: String?) -> Bool {
        if elementType == 50 { return true }
        guard [45, 49, 52].contains(elementType) else { return false }
        // XCUIElementAttributes exposes no secure-text-entry trait; use field metadata as a fallback.
        return [identifier, label, placeholder ?? ""].contains {
            $0.range(
                of: #"password|passcode|passwd|secret|\bpin\b"#, options: [.regularExpression, .caseInsensitive]
            ) != nil
        }
    }
}

struct TVFocusedField: Equatable {
    let identifier: String
    let label: String
    let placeholder: String?
    let isSecure: Bool
}

struct TVNodeSketch {
    let elementType: Int
    var identifier = ""
    var label = ""
    var value: String?
    var placeholder: String?
    var hasFocus = false
    var children: [TVNodeSketch] = []
}

struct TVKeyboardEntry: Equatable {
    let path: [Int]
    let resourceId: String?
    let text: String
    let className = "49"
    let focused = true
}

enum TVTextEntryPolicy {
    static func hasFocusedKeyboard(_ root: TVNodeSketch) -> Bool {
        (root.elementType == 19 && root.hasFocus) || root.children.contains { hasFocusedKeyboard($0) }
    }

    /// Keep the previous field when no field is focused, including after the keyboard closes.
    static func rememberedField(in root: TVNodeSketch, previous: TVFocusedField?) -> TVFocusedField? {
        guard !hasFocusedKeyboard(root) else { return previous }
        return focusedField(in: root) ?? previous
    }

    private static func focusedField(in node: TVNodeSketch) -> TVFocusedField? {
        guard node.elementType != 19 else { return nil }
        if node.hasFocus, [45, 49, 50, 52].contains(node.elementType) {
            return TVFocusedField(
                identifier: node.identifier, label: node.label, placeholder: node.placeholder,
                isSecure: TVSecureField.isSecure(
                    elementType: node.elementType, identifier: node.identifier,
                    label: node.label, placeholder: node.placeholder
                )
            )
        }
        return node.children.lazy.compactMap { focusedField(in: $0) }.first
    }

    static func resolve(
        root: TVNodeSketch, hasFocusedKeyboard: Bool, lastFocusedField: TVFocusedField?
    ) -> TVKeyboardEntry? {
        guard hasFocusedKeyboard else { return nil }
        return entry(in: root, path: [], field: lastFocusedField)
    }

    private static func entry(in node: TVNodeSketch, path: [Int], field: TVFocusedField?) -> TVKeyboardEntry? {
        guard node.elementType != 19 else { return nil }
        if [52, 49].contains(node.elementType) {
            return TVKeyboardEntry(
                path: path, resourceId: field?.identifier,
                text: TVElementText.text(
                    label: field?.label ?? "", value: node.value, placeholder: field?.placeholder,
                    isTextInput: true, isSecure: field?.isSecure ?? true
                )
            )
        }
        for (index, child) in node.children.enumerated() {
            if let match = entry(in: child, path: path + [index], field: field) { return match }
        }
        return nil
    }
}

/// Which application a hierarchy or text command queries. The runner is bound to its host app,
/// and querying a host that is no longer frontmost returns the host's stale tree or waits on
/// XCTest's target-application retry. Kept pure so macOS SwiftPM tests cover the choice.
enum TVTarget: Equatable {
    case host
    case app(bundleId: String)
    /// The tvOS home screen (PineBoard), which is always running and reports foreground.
    case home
}

enum TVTargetResolver {
    /// `XCUIApplication.State.runningForeground`.
    static let foregroundState = 4
    static let homeScreenBundleId = "com.apple.PineBoard"
    /// First-party apps probed when no bundle id is supplied; a request can name any other app.
    static let systemAppBundleIds = [
        "com.apple.TVSettings", "com.apple.TVMusic", "com.apple.TVWatchList", "com.apple.TVAppStore",
        "com.apple.TVPhotos", "com.apple.TVSearch", "com.apple.TVMovies", "com.apple.TVShows",
    ]

    /// The host wins while frontmost; then the first candidate in the foreground; otherwise the
    /// home screen, since a foreground app outside the candidates is indistinguishable from it.
    static func resolve(hostState: Int, candidates: [(bundleId: String, state: Int)]) -> TVTarget {
        if hostState == foregroundState { return .host }
        if let match = candidates.first(where: { $0.state == foregroundState }) {
            return .app(bundleId: match.bundleId)
        }
        return .home
    }

    /// Requested app first, so an app the daemon launched is found even if it is not first-party.
    static func candidateBundleIds(requested: String?) -> [String] {
        let trimmed = requested?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let rest = systemAppBundleIds.filter { $0 != trimmed }
        return trimmed.isEmpty ? rest : [trimmed] + rest
    }
}
