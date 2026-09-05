import Foundation

/// Production `VoiceOverStateProviding`: reads the VoiceOver-running flag from the
/// `com.apple.Accessibility` domain (`VOTIsRunningKey`) through an injected
/// `VoiceOverDefaultsReading`. Holds only an immutable `let` reader → `Sendable`.
struct DefaultVoiceOverStateProvider: VoiceOverStateProviding {
    private static let accessibilityDomain = "com.apple.Accessibility"
    private static let runningKey = "VOTIsRunningKey"

    private let defaultsReader: any VoiceOverDefaultsReading

    init(defaultsReader: any VoiceOverDefaultsReading = SystemVoiceOverDefaultsReader()) {
        self.defaultsReader = defaultsReader
    }

    func isVoiceOverRunning() -> Bool {
        defaultsReader.bool(forKey: Self.runningKey, inDomain: Self.accessibilityDomain)
    }
}
