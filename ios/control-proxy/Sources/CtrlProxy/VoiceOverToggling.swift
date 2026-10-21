import Foundation

/// Drives the VoiceOver on/off switch. On a physical device there is no command-line
/// write into the system-preferences domain, so the only realistic mechanism is
/// automating the Settings app (#2501). Behind a protocol so the command handler's
/// error mapping stays unit-testable with a fake, while the
/// fragile XCUITest automation lives in the default impl. `Sendable` so the command
/// handler can store one.
protocol VoiceOverToggling: Sendable {
    /// Set VoiceOver to `enabled`. The implementation reads the switch value and
    /// no-ops when it already matches. Throws when the switch cannot be located or
    /// its state cannot be read, so the caller can surface a typed failure.
    ///
    /// `@MainActor`: the default impl drives XCUITest (`@MainActor`). The async `Sendable`
    /// `CommandHandler` `await`s it, exactly as it `await`s its other `@MainActor` UI
    /// collaborators (STATUS §6) — automating Settings is one. The protocol stays `Sendable`.
    @MainActor
    func setVoiceOver(enabled: Bool) throws
}
