import Foundation

/// Failure-message selection for `multiFingerSwipe`.
///
/// The real synthesis path is device-only (private XCTest touch synthesis), so this
/// message selection is extracted here to stay verifiable off-device — the same
/// pattern as `PinchFallback`. There is no public XCUITest API that can substitute
/// for a 2+-finger swipe (see issue #2952), so an availability gap degrades to a
/// clear failure rather than a different gesture. Ported verbatim.
public enum MultiFingerSwipeDiagnostics {
    /// Build the client-facing failure message for a failed multi-finger swipe.
    ///
    /// - Parameters:
    ///   - symbolsUnavailable: the bridge's availability signal — `true` only when
    ///     the private XCTest classes/selectors are missing, never for a genuine
    ///     synthesis error.
    ///   - underlying: the bridge's own description of the failure.
    /// - Returns: for an availability gap, `underlying` framed so the reader knows
    ///   this is an OS/XCTest gap with no degraded path; for a genuine failure,
    ///   `underlying` unchanged. The framing is deliberately short — this is the
    ///   third segment of a stacked error message.
    public static func failureMessage(symbolsUnavailable: Bool, underlying: String) -> String {
        guard symbolsUnavailable else {
            return underlying
        }
        return "private XCTest touch synthesis unavailable on this OS/XCTest version, "
            + "and no public XCUITest API can substitute for a 2+-finger swipe. \(underlying)"
    }
}
