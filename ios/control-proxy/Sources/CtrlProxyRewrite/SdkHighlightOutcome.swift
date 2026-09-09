import Foundation

/// Result of asking the in-app SDK bridge to draw a highlight. Ported from the
/// reference `Protocols.swift`.
///
/// Distinguishes a deliberate rejection (the SDK is reachable but declined to render,
/// e.g. missing source dimensions per issue #2682) from the SDK being unreachable. A
/// rejection must fail loudly rather than fall back to the runner overlay, which would
/// draw the highlight unscaled and misplace it.
public enum SdkHighlightOutcome: Equatable, Sendable {
    /// The SDK rendered the highlight (HTTP 200).
    case rendered
    /// The SDK was reachable but declined to render it (non-200 response).
    case rejected
    /// The SDK bridge was unreachable; the caller may fall back to the runner overlay.
    case unavailable
}
