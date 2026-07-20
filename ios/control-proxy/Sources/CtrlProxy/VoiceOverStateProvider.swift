import Foundation

/// Reads the simulator's VoiceOver service liveness state.
///
/// `UIAccessibility.isVoiceOverRunning` can reflect `VoiceOverTouchEnabled`
/// before `com.apple.VoiceOverTouch` has started, so it is not sufficient for
/// confirming a simulator toggle.
public protocol VoiceOverStateProviding {
    func isVoiceOverRunning() -> Bool
}

public final class DefaultVoiceOverStateProvider: VoiceOverStateProviding {
    private static let accessibilityDomain = "com.apple.Accessibility"
    private static let runningKey = "VOTIsRunningKey"

    public init() {}

    public func isVoiceOverRunning() -> Bool {
        #if os(iOS)
            return UserDefaults(suiteName: Self.accessibilityDomain)?
                .bool(forKey: Self.runningKey) ?? false
        #else
            return false
        #endif
    }
}
