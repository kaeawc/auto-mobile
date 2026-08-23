import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

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

/// Drives the VoiceOver on/off switch. On a physical device there is no
/// command-line write into the system-preferences domain, so the only realistic
/// mechanism is automating the Settings app (#2501). Behind a protocol so the
/// command handler's idempotent-early-return and error mapping stay unit-testable
/// with a fake, while the fragile XCUITest automation lives in the default impl.
public protocol VoiceOverToggling {
    /// Set VoiceOver to `enabled`. Throws when the switch cannot be located
    /// (locale/layout drift) so the caller can surface a typed failure rather
    /// than a silent success. Callers must only invoke this when the current
    /// state already differs from `enabled` — once VoiceOver is on, a tap is a
    /// VoiceOver activation, not a toggle.
    func setVoiceOver(enabled: Bool) throws
}

public enum VoiceOverToggleError: LocalizedError {
    case switchNotFound
    case unsupportedPlatform

    public var errorDescription: String? {
        switch self {
        case .switchNotFound:
            return "VoiceOver toggle row not found in Settings (locale or layout drift)"
        case .unsupportedPlatform:
            return "VoiceOver Settings toggle is only available on iOS devices"
        }
    }
}

/// Physical-device VoiceOver toggle by automating Settings → Accessibility.
///
/// Deep-links straight to the Accessibility pane (`App-Prefs:root=ACCESSIBILITY`)
/// to avoid locale-fragile navigation, then taps the VoiceOver switch. English
/// locale only for initial support; the switch is matched by label with an
/// identifier fallback.
public final class DefaultVoiceOverToggle: VoiceOverToggling {
    private static let settingsBundleId = "com.apple.Preferences"
    private static let accessibilityDeepLink = "App-Prefs:root=ACCESSIBILITY"
    private static let switchExistenceTimeout: TimeInterval = 5

    public init() {}

    public func setVoiceOver(enabled _: Bool) throws {
        #if canImport(XCTest) && os(iOS)
            let settings = XCUIApplication(bundleIdentifier: Self.settingsBundleId)
            settings.activate()
            if let url = URL(string: Self.accessibilityDeepLink) {
                XCUIDevice.shared.system.open(url)
            }
            let voSwitch = settings.switches["VoiceOver"].firstMatch
            guard voSwitch.waitForExistence(timeout: Self.switchExistenceTimeout) else {
                throw VoiceOverToggleError.switchNotFound
            }
            // The caller (CommandHandler) has already confirmed the current state
            // differs, so an unconditional tap moves VoiceOver to the target state.
            voSwitch.tap()
        #else
            throw VoiceOverToggleError.unsupportedPlatform
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
