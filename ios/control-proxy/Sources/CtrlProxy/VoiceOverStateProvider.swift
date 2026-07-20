import Foundation

/// Reads the simulator's VoiceOver service liveness state.
///
/// `UIAccessibility.isVoiceOverRunning` can reflect `VoiceOverTouchEnabled`
/// before `com.apple.VoiceOverTouch` has started, so it is not sufficient for
/// confirming a simulator toggle.
public protocol VoiceOverStateProviding {
    func isVoiceOverRunning() -> Bool
}

public protocol VoiceOverDefaultsReading {
    func bool(forKey key: String, inDomain domain: String) -> Bool
}

public final class SystemVoiceOverDefaultsReader: VoiceOverDefaultsReading {
    public init() {}

    public func bool(forKey key: String, inDomain domain: String) -> Bool {
        #if os(iOS)
            return UserDefaults(suiteName: domain)?.bool(forKey: key) ?? false
        #else
            return false
        #endif
    }
}

public final class DefaultVoiceOverStateProvider: VoiceOverStateProviding {
    private static let accessibilityDomain = "com.apple.Accessibility"
    private static let runningKey = "VOTIsRunningKey"

    private let defaultsReader: any VoiceOverDefaultsReading

    public init(defaultsReader: any VoiceOverDefaultsReading = SystemVoiceOverDefaultsReader()) {
        self.defaultsReader = defaultsReader
    }

    public func isVoiceOverRunning() -> Bool {
        return defaultsReader.bool(forKey: Self.runningKey, inDomain: Self.accessibilityDomain)
    }
}
