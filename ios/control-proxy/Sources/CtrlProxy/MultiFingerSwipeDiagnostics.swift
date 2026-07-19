import Foundation

/// Failure-message selection for `multiFingerSwipe`.
///
/// `multiFingerSwipe` synthesizes touches through the same Apple-private XCTest
/// symbols as pinch (`XCPointerEventPath` / `XCSynthesizedEventRecord`). Issue
/// #2910 gave pinch a `symbolsUnavailable` split so a missing-symbol gap could
/// degrade to the public `pinch(withScale:velocity:)`. Issue #2952 adopts the
/// same split here — but stops at the message, because there is **no** public
/// fallback to degrade to:
///
/// - `XCUIElement.swipeLeft/Right/Up/Down` — single-finger, direction-only; they
///   take neither a finger count nor start/end coordinates.
/// - `XCUIElement.pinch(withScale:velocity:)` — two-finger, but the fingers move
///   toward/away from each other; it cannot express a parallel pan.
/// - `XCUIElement.scroll(byDeltaX:deltaY:)` — macOS only.
/// - `XCUICoordinate.press(forDuration:thenDragTo:)` — single-finger.
///
/// Substituting a single-finger swipe would silently perform a *different*
/// gesture — two-finger swipes drive VoiceOver commands and map panning, where a
/// one-finger swipe means something else entirely. A wrong gesture that reports
/// success is worse than a clear failure, so the availability signal is spent on
/// making that failure actionable instead.
///
/// The real synthesis path is device-only, so this selection is extracted here to
/// stay verifiable off-device — the same pattern as `PinchFallback`.
public enum MultiFingerSwipeDiagnostics {

    /// Build the client-facing failure message for a failed multi-finger swipe.
    ///
    /// - Parameters:
    ///   - symbolsUnavailable: the bridge's availability signal — `true` only when
    ///     the private XCTest classes/selectors are missing, never for a genuine
    ///     synthesis error.
    ///   - underlying: the bridge's own description of the failure.
    /// - Returns: for an availability gap, `underlying` framed so the reader knows
    ///   this is an OS/XCTest gap with no degraded path rather than a bad request;
    ///   for a genuine failure, `underlying` unchanged (it is already descriptive,
    ///   and availability framing would misdirect).
    public static func failureMessage(symbolsUnavailable: Bool, underlying: String) -> String {
        guard symbolsUnavailable else {
            return underlying
        }
        return """
            multi-finger swipe unavailable: the private XCTest touch-synthesis symbols this \
            gesture depends on are missing on this OS/XCTest version, and there is no public \
            XCUITest API to approximate an N-finger swipe along an arbitrary vector, so the \
            gesture cannot be degraded. Underlying detail: \(underlying)
            """
    }
}
