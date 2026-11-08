/// Only fixed categories cross the diagnostics boundary; error descriptions and paths never do.
enum ViewerFailure: String, CaseIterable {
    case validation
    case storageLoad = "storage-load"
    case render
    case watchdog
    case libraryCorrupt = "library-corrupt"
    case libraryStorage = "library-storage"

    init(rendererError: PrototypeLoadError) {
        switch rendererError {
        case .invalidSpec, .unsupportedCapabilities: self = .validation
        }
    }
}

/// App-owned facts only. No spec, label, library id, saved state, request or error-message field.
/// Versions and capabilities are supplied by the host, keeping formatting UIKit-free and testable.
struct ViewerDiagnostics {
    let appVersion: String
    let osVersion: String
    let capabilities: Set<String>
    private(set) var lastFailure: ViewerFailure?
    private(set) var watchdogTripped = false

    mutating func record(_ failure: ViewerFailure) {
        lastFailure = failure
        if failure == .watchdog { watchdogTripped = true }
    }

    /// Fixed, unlocalized keys matching Android's clipboard contract, with the iOS OS version.
    func format() -> String {
        [
            "ProtoViewer diagnostics",
            "platform: ios",
            "app-version: \(appVersion)",
            "os-version: \(osVersion)",
            "capabilities: \(capabilities.isEmpty ? "none" : capabilities.sorted().joined(separator: ","))",
            "last-error: \(lastFailure?.rawValue ?? "none")",
            "watchdog-tripped: \(watchdogTripped)",
        ].joined(separator: "\n")
    }
}
