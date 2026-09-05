import Foundation

/// The lifecycle state `awaitAppState` polls for, expressed against
/// `XCUIApplication.State.rawValue`.
///
/// `Sendable` (a trivial value enum) so a `Sendable` `CommandHandler` (Phase 6) off the
/// main actor can pass it into the `@MainActor` `ElementLocating.awaitAppState`.
public enum AppStateExpectation: Sendable {
    /// App should be in the foreground (`XCUIApplication.State.rawValue >= 4`).
    case foreground
    /// App should not be running (`rawValue <= 1`).
    case notRunning
    /// App should be running in the background (`rawValue == 3`).
    case background
}
