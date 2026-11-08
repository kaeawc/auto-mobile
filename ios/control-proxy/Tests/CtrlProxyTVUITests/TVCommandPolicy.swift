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
    static func text(label: String, value: String?, isTextInput: Bool, isSecure: Bool) -> String {
        guard !isSecure, isTextInput, let value, !value.isEmpty else { return label }
        // Emit the value alone for an empty or matching label; otherwise join label and value with one space.
        return label.isEmpty || label == value ? value : "\(label) \(value)"
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
