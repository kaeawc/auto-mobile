@testable import CtrlProxyRewrite
import Foundation
import os

/// Drives the `CtrlProxyRewrite` VoiceOver providers (see `ReferenceVoiceOver`).
/// `@testable` reaches the internal provider types.
enum RewriteVoiceOver {
    /// Records the `(key, domain)` the provider asks for and returns a fixed result.
    /// The rewrite's `VoiceOverDefaultsReading` is `Sendable`, so the recorder guards
    /// its recorded value with an `OSAllocatedUnfairLock`.
    private final class RecordingReader: VoiceOverDefaultsReading {
        let result: Bool
        let recorded = OSAllocatedUnfairLock<(key: String, domain: String)?>(initialState: nil)
        init(result: Bool) { self.result = result }
        func bool(forKey key: String, inDomain domain: String) -> Bool {
            recorded.withLock { $0 = (key, domain) }
            return result
        }
    }

    static func stateRead(configuredRunning: Bool) -> (result: Bool, key: String, domain: String) {
        let reader = RecordingReader(result: configuredRunning)
        let result = DefaultVoiceOverStateProvider(defaultsReader: reader).isVoiceOverRunning()
        let recorded = reader.recorded.withLock { $0 }
        return (result, recorded?.key ?? "<none>", recorded?.domain ?? "<none>")
    }

    static func toggleErrorDescriptions() -> (switchNotFound: String, unsupportedPlatform: String) {
        (
            VoiceOverToggleError.switchNotFound.errorDescription ?? "",
            VoiceOverToggleError.unsupportedPlatform.errorDescription ?? ""
        )
    }

    static func systemDefaultsReaderBool() -> Bool {
        SystemVoiceOverDefaultsReader().bool(forKey: "VOTIsRunningKey", inDomain: "com.apple.Accessibility")
    }

    static func defaultToggleErrorDescription() -> String? {
        // `setVoiceOver` is `@MainActor`; this helper stays nonisolated (the parity test
        // is not). XCTest runs the test method on the main thread, so `assumeIsolated` is
        // safe, and the macOS `#else` stub throws `.unsupportedPlatform` here regardless.
        MainActor.assumeIsolated {
            do {
                try DefaultVoiceOverToggle().setVoiceOver(enabled: true)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
    }
}
