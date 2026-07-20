import Foundation

/// Failure-message selection for `multiFingerSwipe`.
///
/// `multiFingerSwipe` synthesizes touches through the same Apple-private XCTest
/// symbols as pinch (`XCPointerEventPath` / `XCSynthesizedEventRecord`). Issue
/// #2910 gave pinch a `symbolsUnavailable` split so a missing-symbol gap could
/// degrade to the public `pinch(withScale:velocity:)`. Issue #2952 adopts the
/// same split here — but stops at the message, because for **two or more
/// fingers** there is no public XCUITest API that delivers simultaneous touch
/// paths translating in parallel.
///
/// #2952 specifically asked whether the 2-finger case could be approximated with
/// the public `pinch`/`scroll` primitives. It cannot. The full public multi-touch
/// surface of `XCUIElement` is `twoFingerTap`,
/// `tapWithNumberOfTaps:numberOfTouches:`, `pinch(withScale:velocity:)`, and
/// `rotate(_:withVelocity:)`. The two continuous ones move the touches toward and
/// away from each other (pinch) or circularly about a center (rotate); neither
/// takes a translation vector, so neither can express a parallel two-finger pan.
/// The tap-based ones are discrete.
///
/// The single-finger APIs are unusable for a different reason:
/// `XCUIElement.swipeLeft/Right/Up/Down` are direction-only (no coordinates), and
/// `XCUICoordinate.press(forDuration:thenDragTo:)` carries one touch.
///
/// `XCUIElement.scroll(byDeltaX:deltaY:)` is **not** ruled out by availability —
/// it is `API_AVAILABLE(ios(15.0))`. It is ruled out because it lives in the
/// `XCUIElementMouseEvents` category and delivers a pointer/scroll-wheel event
/// rather than synthesized touches, so it cannot drive a two-finger map pan — a
/// gesture `multiFingerSwipe` exists to produce. Synthesized touches are delivered
/// below VoiceOver's gesture layer, so neither path can drive VoiceOver gestures.
///
/// Scope of that claim: it holds for `fingerCount >= 2`. A `fingerCount` of 1 is
/// reachable (the bridge clamps with `fingerCount > 1 ? fingerCount : 1`) and does
/// have a public equivalent — `GesturePerformer.swipe` — but a 1-finger
/// "multi-finger" swipe is a degenerate call that no caller makes deliberately, so
/// the runner does not special-case it.
///
/// Why the runner does not substitute a single-finger swipe for N >= 2: it would
/// silently perform a *different* gesture — for example, a map pan can become a
/// drag, where a one-finger swipe means something else entirely. The runner
/// therefore reports a clear failure and spends the availability signal on making
/// that failure actionable. Note this is the *runner's* policy only: a TypeScript
/// caller may still choose to degrade, and `VoiceOverSwipeExecutor` currently does
/// exactly that (see issue #3993).
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
    ///
    /// The framing is kept short deliberately. `GestureError.gestureFailed` prepends
    /// "Gesture failed: " and the TypeScript layer prepends "iOS multi-finger gesture
    /// failed: ", so this string is the third segment of a stacked message — and long
    /// error text costs agent context (the repo's output-reduction posture).
    public static func failureMessage(symbolsUnavailable: Bool, underlying: String) -> String {
        guard symbolsUnavailable else {
            return underlying
        }
        return "private XCTest touch synthesis unavailable on this OS/XCTest version, "
            + "and no public XCUITest API can substitute for a 2+-finger swipe. \(underlying)"
    }
}
