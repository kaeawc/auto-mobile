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
    )
        -> String
    {
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
        return [identifier, label, placeholder ?? ""].contains { metadata in
            if metadata.range(
                of: #"password|passcode|passwd|secret"#, options: [.regularExpression, .caseInsensitive]
            ) != nil { return true }
            // Split camelCase and acronyms before treating punctuation and digits as token boundaries.
            let tokens = metadata.replacingOccurrences(
                of: #"(\p{Ll})(\p{Lu})"#, with: "$1 $2", options: .regularExpression
            ).replacingOccurrences(
                of: #"(\p{Lu})(\p{Lu}\p{Ll})"#, with: "$1 $2", options: .regularExpression
            ).components(separatedBy: CharacterSet.letters.inverted)
            return tokens.contains { $0.lowercased() == "pin" }
        }
    }
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

struct TVTextEntryResolution {
    let keyboardPresent: Bool

    /// A system keyboard can expose secure input in an anonymous text view even without a keyboard node.
    func text(for node: TVNodeSketch) -> String {
        let isAnonymousTextView = node.elementType == 52 && node.identifier.isEmpty && node.label.isEmpty
            && (node.placeholder ?? "").isEmpty
        return TVElementText.text(
            label: node.label, value: node.value, placeholder: node.placeholder,
            isTextInput: TVTextEntryPolicy.isTextInput(node.elementType),
            isSecure: keyboardPresent || isAnonymousTextView || TVSecureField.isSecure(
                elementType: node.elementType, identifier: node.identifier,
                label: node.label, placeholder: node.placeholder
            )
        )
    }
}

enum TVTextEntryPolicy {
    static func isTextInput(_ elementType: Int) -> Bool {
        [45, 49, 50, 52].contains(elementType)
    }

    static func hasKeyboard(_ root: TVNodeSketch) -> Bool {
        root.elementType == 19 || root.children.contains { hasKeyboard($0) }
    }

    static func hasFocusedKeyboard(_ root: TVNodeSketch) -> Bool {
        (root.elementType == 19 && root.hasFocus) || root.children.contains { hasFocusedKeyboard($0) }
    }

    static func resolve(root: TVNodeSketch) -> TVTextEntryResolution {
        TVTextEntryResolution(keyboardPresent: hasKeyboard(root))
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
