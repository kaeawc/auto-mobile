import CoreGraphics
import Foundation

/// Platform-agnostic math for the public-API pinch fallback.
///
/// Extracted from the iOS-only `GesturePerformer` so the geometry → scale/velocity
/// mapping is unit-testable off-device (the real `app.pinch(...)` call cannot run
/// in a macOS test host). See issue #2910. Pure value math — ported verbatim.
public enum PinchFallback {
    /// Clamp bounds keep `scale` a sane, strictly-positive multiplier even for
    /// degenerate geometry. Apple documents `scale` in (0,1) as zoom-out and
    /// `> 1` as zoom-in.
    private static let minScale: CGFloat = 0.01
    private static let maxScale: CGFloat = 100
    /// Apple documents `velocity` only as "scale factor per second" — it does not
    /// specify a nonzero requirement, but a zero velocity is a degenerate no-op,
    /// so we defensively floor the magnitude to stay clear of it.
    private static let minVelocityMagnitude: CGFloat = 0.1
    private static let defaultDuration: TimeInterval = 0.3

    /// Compute the public-API `pinch(withScale:velocity:)` parameters from the
    /// requested pinch geometry.
    ///
    /// - `scale`   = `distanceEnd / distanceStart`, clamped to a positive range.
    /// - `velocity` = `(scale - 1) / duration`, floored to a nonzero magnitude.
    ///   Deriving velocity as the scale-factor rate of change makes its sign
    ///   follow the zoom direction (zoom-in `scale > 1` positive, zoom-out
    ///   `scale < 1` negative), the natural reading of Apple's "scale factor per
    ///   second"; the floor keeps it clear of a degenerate zero velocity.
    public static func parameters(
        distanceStart: Double,
        distanceEnd: Double,
        duration: TimeInterval
    ) -> (scale: CGFloat, velocity: CGFloat) {
        let safeStart = distanceStart > 0 ? distanceStart : 1
        let safeEnd = distanceEnd > 0 ? distanceEnd : safeStart * Double(minScale)
        let rawScale = CGFloat(safeEnd / safeStart)
        let scale = min(max(rawScale, minScale), maxScale)

        let safeDuration = duration > 0 ? duration : defaultDuration
        var velocity = (scale - 1) / CGFloat(safeDuration)
        if abs(velocity) < minVelocityMagnitude {
            // Degenerate / no-op pinch: preserve a valid nonzero velocity whose
            // sign still matches the (possibly absent) zoom direction.
            velocity = (scale >= 1 ? 1 : -1) * minVelocityMagnitude
        }
        return (scale, velocity)
    }
}
