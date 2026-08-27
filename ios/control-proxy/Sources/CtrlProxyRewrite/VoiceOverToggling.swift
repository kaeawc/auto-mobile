import Foundation

/// Drives the VoiceOver on/off switch. On a physical device there is no command-line
/// write into the system-preferences domain, so the only realistic mechanism is
/// automating the Settings app (#2501). Behind a protocol so the command handler's
/// idempotent-early-return and error mapping stay unit-testable with a fake, while the
/// fragile XCUITest automation lives in the default impl. `Sendable` so the command
/// handler can store one.
protocol VoiceOverToggling: Sendable {
    /// Set VoiceOver to `enabled`. Throws when the switch cannot be located
    /// (locale/layout drift) so the caller can surface a typed failure rather than a
    /// silent success. Callers must only invoke this when the current state already
    /// differs from `enabled` — once VoiceOver is on, a tap is a VoiceOver activation,
    /// not a toggle.
    func setVoiceOver(enabled: Bool) throws
}
