import Foundation

/// Production `VoiceOverDefaultsReading` over `UserDefaults`. Stateless → genuinely
/// `Sendable` (the reference was a `final class`).
struct SystemVoiceOverDefaultsReader: VoiceOverDefaultsReading {
    func bool(forKey key: String, inDomain domain: String) -> Bool {
        #if os(iOS)
            return UserDefaults(suiteName: domain)?.bool(forKey: key) ?? false
        #else
            return false
        #endif
    }
}
