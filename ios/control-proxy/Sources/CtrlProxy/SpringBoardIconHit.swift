import Foundation

/// A drag that starts on a SpringBoard icon (home screen grid or dock) never lifts it on iOS 27.2:
/// both the XCUICoordinate press-then-drag and the synthesized `XCPointerEventPath` stroke, and
/// even HID digitizer touches, open the icon's context menu and drop the moves (#18859). The runner
/// refuses such a stroke before any input instead of reporting a success that moved nothing.
///
/// SpringBoard keeps icon views in its tree while an app covers them, so a frame match alone is
/// only a candidate; the caller confirms the candidate is hittable at the point.
enum SpringBoardIconHit {
    struct Icon: Equatable {
        let identifier: String
        let label: String
        let frame: CGRect
    }

    /// Icons whose frame contains `point`, smallest first (a folder icon encloses nothing, but a
    /// zero-size or offscreen-page icon never qualifies).
    static func candidates(at point: CGPoint, in icons: [Icon]) -> [Icon] {
        icons
            .filter { $0.frame.width > 0 && $0.frame.height > 0 && $0.frame.contains(point) }
            .sorted { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    /// How long a touch must dwell at its start before SpringBoard treats it as a long press and
    /// opens the icon's context menu. A flick that moves sooner pages the home screen as usual.
    static let holdThreshold: TimeInterval = 0.4

    /// How far a touch may drift from its first point and still count as holding there.
    static let touchSlop: Double = 10

    /// A press-then-drag holds at its start when its press lasts at least the hold threshold.
    static func dragHoldsAtStart(pressDuration: TimeInterval) -> Bool {
        pressDuration >= holdThreshold
    }

    /// A path holds at its start when the finger stays within the touch slop of its first point
    /// for at least the hold threshold. The moment it leaves is interpolated along the segment
    /// that crosses the slop circle, so a fast stroke with sparse points is not misread as held.
    static func pathHoldsAtStart(_ points: [PathGesturePoint]) -> Bool {
        guard let first = points.first else { return false }
        return timeWithinSlop(points, of: first) >= holdThreshold
    }

    private static func timeWithinSlop(_ points: [PathGesturePoint], of first: PathGesturePoint) -> TimeInterval {
        let start = Double(first.offsetMs)
        for (from, to) in zip(points, points.dropFirst()) {
            let ax = from.x - first.x, ay = from.y - first.y
            let dx = to.x - from.x, dy = to.y - from.y
            guard (to.x - first.x) * (to.x - first.x) + (to.y - first.y) * (to.y - first.y) > touchSlop * touchSlop
            else { continue }
            // Solve |a + t·d| = slop for the crossing t in [0, 1]; `from` is inside the circle.
            let qa = dx * dx + dy * dy
            let qb = 2 * (ax * dx + ay * dy)
            let qc = ax * ax + ay * ay - touchSlop * touchSlop
            let t = qa > 0 ? min(1, max(0, (-qb + (qb * qb - 4 * qa * qc).squareRoot()) / (2 * qa))) : 0
            let leftAt = Double(from.offsetMs) + t * Double(to.offsetMs - from.offsetMs)
            return (leftAt - start) / 1000.0
        }
        return (Double(points.last?.offsetMs ?? first.offsetMs) - start) / 1000.0
    }

    /// Name used in the refusal: the icon's label, else its identifier, else a generic word.
    static func displayName(_ icon: Icon) -> String {
        if !icon.label.isEmpty { return icon.label }
        if !icon.identifier.isEmpty { return icon.identifier }
        return "a SpringBoard icon"
    }
}
