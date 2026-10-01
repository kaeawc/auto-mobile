import Foundation

/// Typed failure from `VoiceOverToggling`. `Sendable` for propagation across isolation
/// domains (the command handler surfaces it as a structured WebSocket error).
enum VoiceOverToggleError: LocalizedError, Equatable, Sendable {
    case switchNotFound
    case switchStateUnreadable
    case unsupportedPlatform

    var errorDescription: String? {
        switch self {
        case .switchNotFound:
            return "VoiceOver toggle row not found in Settings (locale or layout drift)"
        case .switchStateUnreadable:
            return "VoiceOver switch state could not be read in Settings"
        case .unsupportedPlatform:
            return "VoiceOver Settings toggle is only available on iOS devices"
        }
    }
}
