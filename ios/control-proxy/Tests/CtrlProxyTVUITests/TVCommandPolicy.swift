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

struct TVTextEntryResolution {
    let keyboardPresent: Bool
    let entry: TVKeyboardEntry?

    func overrideEntry(at path: [Int]) -> TVKeyboardEntry? {
        entry.flatMap { $0.path == path ? $0 : nil }
    }

    /// Every node uses this policy, including inputs not selected for the keyboard override.
    func text(for node: TVNodeSketch, path: [Int]) -> String {
        if let entry = overrideEntry(at: path) { return entry.text }
        return TVElementText.text(
            label: node.label, value: node.value, placeholder: node.placeholder,
            isTextInput: TVTextEntryPolicy.isTextInput(node.elementType),
            isSecure: keyboardPresent || TVSecureField.isSecure(
                elementType: node.elementType, identifier: node.identifier,
                label: node.label, placeholder: node.placeholder
            )
        )
    }
}

/// Retain identity only for a known generation of the current target app.
struct TVFocusMemory {
    private var bundleId: String?
    private var processToken: Int?
    private var remembered: TVFocusedField?

    mutating func field(for bundle: String, processToken: Int?) -> TVFocusedField? {
        guard let processToken, bundle == bundleId, processToken == self.processToken else {
            remembered = nil
            return nil
        }
        return remembered
    }

    mutating func observe(bundle: String, processToken: Int?, root: TVNodeSketch) {
        let previous = field(for: bundle, processToken: processToken)
        bundleId = bundle
        self.processToken = processToken
        remembered = processToken == nil ? nil : TVTextEntryPolicy.rememberedField(in: root, previous: previous)
    }

    mutating func willSelect(bundle: String, processToken: Int?, snapshot: TVNodeSketch?) {
        bundleId = bundle
        self.processToken = processToken
        remembered = nil
        guard processToken != nil, let snapshot, !TVTextEntryPolicy.hasKeyboard(snapshot) else { return }
        // A select can open a different field: only the input focused in this snapshot is evidence.
        remembered = TVTextEntryPolicy.rememberedField(in: snapshot, previous: nil)
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

    /// Keep the previous field when no field is focused, including after the keyboard closes.
    static func rememberedField(in root: TVNodeSketch, previous: TVFocusedField?) -> TVFocusedField? {
        if hasKeyboard(root) { return matchingField(in: root, previous: previous) }
        return focusedField(in: root) ?? previous
    }

    private static func focusedField(in node: TVNodeSketch) -> TVFocusedField? {
        guard node.elementType != 19 else { return nil }
        if node.hasFocus, isTextInput(node.elementType) {
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
        root: TVNodeSketch, lastFocusedField: TVFocusedField?
    )
        -> TVTextEntryResolution
    {
        let keyboardPresent = hasKeyboard(root)
        guard keyboardPresent else { return TVTextEntryResolution(keyboardPresent: false, entry: nil) }
        let candidates = entries(in: root, path: [])
        // A prompt identifies a session, not which of multiple inputs owns the value.
        guard candidates.count == 1 else { return TVTextEntryResolution(keyboardPresent: true, entry: nil) }
        let field = matchingField(in: root, previous: lastFocusedField)
        let entry = candidates.first.map { candidate in
            let node = candidate.node
            return TVKeyboardEntry(
                path: candidate.path, resourceId: field?.identifier,
                text: TVElementText.text(
                    label: field?.label ?? node.label, value: node.value, placeholder: field?.placeholder,
                    isTextInput: true, isSecure: (field?.isSecure ?? true) || TVSecureField.isSecure(
                        elementType: node.elementType, identifier: node.identifier,
                        label: node.label, placeholder: node.placeholder
                    )
                )
            )
        }
        return TVTextEntryResolution(keyboardPresent: true, entry: entry)
    }

    private static func matchingField(in root: TVNodeSketch, previous: TVFocusedField?) -> TVFocusedField? {
        guard let previous, let prompt = prompt(in: root), !prompt.isEmpty,
              prompt == previous.placeholder || prompt == previous.label else { return nil }
        return previous
    }

    private static func prompt(in node: TVNodeSketch) -> String? {
        guard node.elementType != 19 else { return nil }
        if node.elementType == 48 { return node.label }
        return node.children.lazy.compactMap { prompt(in: $0) }.first
    }

    private static func entries(in node: TVNodeSketch, path: [Int]) -> [(path: [Int], node: TVNodeSketch)] {
        guard node.elementType != 19 else { return [] }
        let current = isTextInput(node.elementType) ? [(path: path, node: node)] : []
        return current + node.children.enumerated().flatMap { index, child in
            entries(in: child, path: path + [index])
        }
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
