import Foundation

/// Observed app lifecycle state, mirroring `XCUIApplication.State`.
///
/// `Sendable` (a trivial value enum): `ElementLocating` is `@MainActor`, so a
/// `Sendable` `CommandHandler` (Phase 6) `await`s `getAppState` from off the main
/// actor and the marker lets the returned state cross that isolation boundary.
public enum ObservedAppState: Sendable {
    case unknown
    case notRunning
    case runningBackgroundSuspended
    case runningBackground
    case runningForeground
}
