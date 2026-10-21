import Foundation

/// Reads a boolean default from a named preferences domain. Injected into
/// `DefaultVoiceOverStateProvider` so the VoiceOver-running check is unit-testable
/// without touching the real `com.apple.Accessibility` domain. `Sendable` so the
/// provider that stores one stays `Sendable`.
/// Returns `nil` when the domain itself cannot be read (so "unknown" is not conflated with
/// "off"); a readable domain with an absent key is `false`.
protocol VoiceOverDefaultsReading: Sendable {
    func bool(forKey key: String, inDomain domain: String) -> Bool?
}
