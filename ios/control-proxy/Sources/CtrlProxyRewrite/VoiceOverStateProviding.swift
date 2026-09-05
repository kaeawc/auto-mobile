import Foundation

/// Reads the simulator's VoiceOver service liveness state.
///
/// `UIAccessibility.isVoiceOverRunning` can reflect `VoiceOverTouchEnabled` before
/// `com.apple.VoiceOverTouch` has started, so it is not sufficient for confirming a
/// simulator toggle. `Sendable` so the (`Sendable`) command handler can store one.
protocol VoiceOverStateProviding: Sendable {
    func isVoiceOverRunning() -> Bool
}
