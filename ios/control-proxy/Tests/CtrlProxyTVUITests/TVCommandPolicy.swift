import Foundation
#if SWIFT_PACKAGE
    import CtrlProxy
#endif

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

/// Remote holds use the same 100...10000 ms contract as pressButtonPolicy.ts.
enum TVRemoteHold {
    static func seconds(durationMs: Int?) throws -> TimeInterval? {
        guard let durationMs else { return nil }
        guard (100...10000).contains(durationMs) else {
            throw CommandError.invalidParameter("durationMs", "\(durationMs); expected 100...10000 ms")
        }
        return TimeInterval(durationMs) / 1000
    }
}

enum TVElementText {
    static func text(
        label: String, value: String?, placeholder: String? = nil, isTextInput: Bool, isSecure: Bool
    )
        -> String
    {
        guard !isSecure, isTextInput, let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value != placeholder else { return label }
        // Emit the value alone for an empty or matching label; otherwise join label and value with one space.
        return label.trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty || label == value ? value : "\(label) \(value)"
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
    let withholdTextInputValues: Bool

    init(keyboardPresent: Bool, withholdTextInputValues: Bool = false) {
        self.keyboardPresent = keyboardPresent
        self.withholdTextInputValues = withholdTextInputValues
    }

    /// A system keyboard can expose secure input in an anonymous input even without a keyboard node.
    func text(for node: TVNodeSketch) -> String {
        let isAnonymousTextInput = TVTextEntryPolicy.isAnonymousTextInput(node)
        return TVElementText.text(
            label: node.label, value: node.value, placeholder: node.placeholder,
            isTextInput: TVTextEntryPolicy.isTextInput(node.elementType),
            isSecure: keyboardPresent || withholdTextInputValues || isAnonymousTextInput || TVSecureField.isSecure(
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

    static func isAnonymousTextInput(_ node: TVNodeSketch) -> Bool {
        [45, 49, 52].contains(node.elementType)
            && [node.identifier, node.label, node.placeholder ?? ""].allSatisfy {
                $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
    }

    static func hasAnonymousTextInput(_ root: TVNodeSketch) -> Bool {
        isAnonymousTextInput(root) || root.children.contains { hasAnonymousTextInput($0) }
    }

    static func resolve(root: TVNodeSketch) -> TVTextEntryResolution {
        TVTextEntryResolution(keyboardPresent: hasKeyboard(root))
    }
}

protocol TVUptimeClock {
    func now() -> TimeInterval
}

struct TVSystemUptimeClock: TVUptimeClock {
    func now() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }
}

/// Keep values withheld through keyboard animation frames that temporarily omit the keyboard node.
final class TVKeyboardSettleGate {
    static let settleWindow: TimeInterval = 1.0

    private let clock: any TVUptimeClock
    private var lastKeyboardSeen: TimeInterval?

    init(clock: any TVUptimeClock) {
        self.clock = clock
        lastKeyboardSeen = clock.now()
    }

    /// A failed snapshot cannot prove that the keyboard is absent.
    func noteSnapshotFailure() {
        lastKeyboardSeen = clock.now()
    }

    func resolve(root: TVNodeSketch) -> TVTextEntryResolution {
        let now = clock.now()
        let keyboardPresent = TVTextEntryPolicy.hasKeyboard(root)
        var withhold = !now.isFinite
        if keyboardPresent {
            lastKeyboardSeen = now
            withhold = true
        } else if let lastKeyboardSeen {
            if now.isFinite, lastKeyboardSeen.isFinite, now >= lastKeyboardSeen,
               now - lastKeyboardSeen >= Self.settleWindow,
               !TVTextEntryPolicy.hasAnonymousTextInput(root)
            {
                self.lastKeyboardSeen = nil
            } else {
                withhold = true
            }
        }
        return TVTextEntryResolution(keyboardPresent: keyboardPresent, withholdTextInputValues: withhold)
    }
}

/// Gate orchestration shared by the XCTest router and device-free policy tests.
final class TVTextEntryCommands {
    private let keyboardSettleGate: TVKeyboardSettleGate

    init(clock: any TVUptimeClock) {
        keyboardSettleGate = TVKeyboardSettleGate(clock: clock)
    }

    func hierarchy<Snapshot>(
        snapshot: () throws -> Snapshot, sketch: (Snapshot) -> TVNodeSketch
    )
        throws -> (snapshot: Snapshot, root: TVNodeSketch, resolution: TVTextEntryResolution)
    {
        let captured: Snapshot
        do {
            captured = try snapshot()
        } catch {
            keyboardSettleGate.noteSnapshotFailure()
            throw error
        }
        let root = sketch(captured)
        return (captured, root, keyboardSettleGate.resolve(root: root))
    }

    func press(
        _ button: TVRemoteButton, perform: (TVRemoteButton) -> Void,
        snapshot: () throws -> TVNodeSketch
    ) {
        perform(button)
        do {
            _ = try keyboardSettleGate.resolve(root: snapshot())
        } catch {
            // The press succeeded; withhold values conservatively if its snapshot fails.
            keyboardSettleGate.noteSnapshotFailure()
        }
    }

    func appendText(snapshot: () throws -> TVNodeSketch, typeText: () -> Void) throws -> Bool {
        let root = try hierarchy(snapshot: snapshot, sketch: { $0 }).root
        guard TVTextEntryPolicy.hasFocusedKeyboard(root) else { return false }
        typeText()
        // Typing can outlast the settle window; the known keyboard was in use until now.
        _ = keyboardSettleGate.resolve(root: root)
        return true
    }
}

/// Which application a hierarchy, press or text command queries. The runner is bound to its host app,
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
