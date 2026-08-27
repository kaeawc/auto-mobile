import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Physical-device VoiceOver toggle by automating Settings → Accessibility.
///
/// Deep-links straight to the Accessibility pane (`App-Prefs:root=ACCESSIBILITY`) to
/// avoid locale-fragile navigation, then taps the VoiceOver switch. English locale
/// only for initial support; the switch is matched by label with an identifier
/// fallback. Stateless → genuinely `Sendable` (the reference was a `final class`).
struct DefaultVoiceOverToggle: VoiceOverToggling {
    private static let settingsBundleId = "com.apple.Preferences"
    private static let accessibilityDeepLink = "App-Prefs:root=ACCESSIBILITY"
    private static let switchExistenceTimeout: TimeInterval = 5

    @MainActor
    func setVoiceOver(enabled _: Bool) throws {
        #if canImport(XCTest) && os(iOS)
            let settings = XCUIApplication(bundleIdentifier: Self.settingsBundleId)
            settings.activate()
            if let url = URL(string: Self.accessibilityDeepLink) {
                XCUIDevice.shared.system.open(url)
            }
            // The Accessibility root pane lists "VoiceOver" as a navigation row that
            // pushes a sub-page; the on/off switch lives on that sub-page, not at the
            // root. If no VoiceOver switch is present at the current level, drill into
            // the VoiceOver row first, then match the switch on the sub-page. Guarding
            // on the switch's presence (rather than assuming the level) keeps this
            // working if a future iOS surfaces the switch higher.
            if !settings.switches["VoiceOver"].firstMatch.waitForExistence(timeout: Self.switchExistenceTimeout) {
                let voRow = settings.cells["VoiceOver"].firstMatch
                guard voRow.waitForExistence(timeout: Self.switchExistenceTimeout) else {
                    throw VoiceOverToggleError.switchNotFound
                }
                voRow.tap()
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
