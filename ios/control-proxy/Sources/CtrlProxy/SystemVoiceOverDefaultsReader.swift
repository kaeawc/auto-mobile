import Foundation

struct SystemVoiceOverDefaultsReader: VoiceOverDefaultsReading {
    func bool(forKey key: String, inDomain domain: String) -> Bool? {
        #if os(iOS)
            return UserDefaults(suiteName: domain)?.bool(forKey: key)
        #else
            return nil
        #endif
    }
}
