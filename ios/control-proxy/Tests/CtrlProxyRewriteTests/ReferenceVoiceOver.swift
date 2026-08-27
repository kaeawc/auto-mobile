import CtrlProxy
import Foundation

/// Drives the REFERENCE `CtrlProxy` VoiceOver providers, returning module-agnostic
/// values. Imports only `CtrlProxy`; the VoiceOver types are public there.
enum ReferenceVoiceOver {
    /// Records the `(key, domain)` the provider asks for and returns a fixed result.
    private final class RecordingReader: VoiceOverDefaultsReading {
        let result: Bool
        var recordedKey: String?
        var recordedDomain: String?
        init(result: Bool) { self.result = result }
        func bool(forKey key: String, inDomain domain: String) -> Bool {
            recordedKey = key
            recordedDomain = domain
            return result
        }
    }

    /// Result of `isVoiceOverRunning()` plus the `(key, domain)` it read.
    static func stateRead(configuredRunning: Bool) -> (result: Bool, key: String, domain: String) {
        let reader = RecordingReader(result: configuredRunning)
        let result = DefaultVoiceOverStateProvider(defaultsReader: reader).isVoiceOverRunning()
        return (result, reader.recordedKey ?? "<none>", reader.recordedDomain ?? "<none>")
    }

    static func toggleErrorDescriptions() -> (switchNotFound: String, unsupportedPlatform: String) {
        (
            VoiceOverToggleError.switchNotFound.errorDescription ?? "",
            VoiceOverToggleError.unsupportedPlatform.errorDescription ?? ""
        )
    }

    /// `SystemVoiceOverDefaultsReader` on the macOS host takes its `#else` stub → false.
    static func systemDefaultsReaderBool() -> Bool {
        SystemVoiceOverDefaultsReader().bool(forKey: "VOTIsRunningKey", inDomain: "com.apple.Accessibility")
    }

    /// `DefaultVoiceOverToggle` on the macOS host throws `unsupportedPlatform`.
    static func defaultToggleErrorDescription() -> String? {
        do {
            try DefaultVoiceOverToggle().setVoiceOver(enabled: true)
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
