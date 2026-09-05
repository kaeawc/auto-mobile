import Foundation

/// Reads a boolean default from a named preferences domain. Injected into
/// `DefaultVoiceOverStateProvider` so the VoiceOver-running check is unit-testable
/// without touching the real `com.apple.Accessibility` domain. `Sendable` so the
/// provider that stores one stays `Sendable`.
protocol VoiceOverDefaultsReading: Sendable {
    func bool(forKey key: String, inDomain domain: String) -> Bool
}
