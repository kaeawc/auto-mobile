import Foundation

public enum SdkHighlightOutcome: Equatable, Sendable {
    /// The SDK rendered the highlight (HTTP 200).
    case rendered
    /// The SDK was reachable but declined to render it (non-200 response).
    case rejected
    /// The SDK bridge was unreachable; the caller may fall back to the runner overlay.
    case unavailable
}
