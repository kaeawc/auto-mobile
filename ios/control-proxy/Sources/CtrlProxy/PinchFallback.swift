import CoreGraphics
import Foundation

/// Which mechanism performed a pinch gesture.
///
/// `pinchOn` prefers the private XCTest event-path synthesis because it honors an
/// arbitrary `centerX`/`centerY`. When those private symbols are unavailable it
/// falls back to the public, element-anchored `pinch(withScale:velocity:)`, which
/// still zooms but centers on the anchor element (the SpringBoard full screen).
/// Callers use this to know whether the requested center was respected. See
/// issue #2910.
public enum PinchGesturePath: String, Codable, Equatable {
    /// Private `XCPointerEventPath`/`XCSynthesizedEventRecord` synthesis — honors center.
    case eventPath = "event-path"
    /// Public `XCUIElement.pinch(withScale:velocity:)` — center-less, anchor-centered.
    case elementAnchored = "element-anchored"
}

/// Platform-agnostic math for the public-API pinch fallback.
///
/// Extracted from the iOS-only `GesturePerformer` so the geometry → scale/velocity
/// mapping is unit-testable off-device (the real `app.pinch(...)` call cannot run
/// in a macOS test host). See issue #2910.
public enum PinchFallback {
    /// Clamp bounds keep `scale` a sane, strictly-positive multiplier even for
    /// degenerate geometry. Apple: `scale` in (0,1) zooms out, `> 1` zooms in.
    private static let minScale: CGFloat = 0.01
    private static let maxScale: CGFloat = 100
    /// XCUITest rejects a zero velocity; keep magnitude above this floor.
    private static let minVelocityMagnitude: CGFloat = 0.1
    private static let defaultDuration: TimeInterval = 0.3

    /// Compute the public-API `pinch(withScale:velocity:)` parameters from the
    /// requested pinch geometry.
    ///
    /// - `scale`   = `distanceEnd / distanceStart`, clamped to a positive range.
    /// - `velocity` = `(scale - 1) / duration`, floored to a nonzero magnitude.
    ///   Sign follows zoom direction: zoom-in (`scale > 1`) is positive,
    ///   zoom-out (`scale < 1`) is negative — matching Apple's requirement that
    ///   velocity be negative when zooming out.
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
