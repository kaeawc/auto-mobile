import Foundation

enum PrototypeFadeEdges {
    enum Edge: Equatable { case top, bottom, left, right }
    struct Fade: Equatable {
        let edge: Edge
        let length: Double
    }

    static func resolve(
        axis: String?,
        rightToLeft: Bool,
        canScrollBackward: Bool,
        canScrollForward: Bool,
        spec: FadeEdges?
    )
        -> [Fade]
    {
        guard let spec else { return [] }
        let horizontal = axis == "horizontal"
        let backward: Edge = horizontal ? (rightToLeft ? .right : .left) : .top
        let forward: Edge = horizontal ? (rightToLeft ? .left : .right) : .bottom
        return [
            (backward, canScrollBackward, horizontal ? spec.start : spec.top),
            (forward, canScrollForward, horizontal ? spec.end : spec.bottom),
        ].compactMap { edge, visible, length in
            guard visible, let length, length > 0 else { return nil }
            return Fade(edge: edge, length: length)
        }
    }

    /// Content bounds in viewport coordinates also handle bounce and RTL without relying on offset signs.
    static func scrollability(
        min: Double,
        max: Double,
        viewport: Double,
        horizontal: Bool,
        rightToLeft: Bool
    )
        -> (backward: Bool, forward: Bool)
    {
        let low = min < -0.5
        let high = max > viewport + 0.5
        return horizontal && rightToLeft ? (high, low) : (low, high)
    }

    /// Opposing fades meet at the midpoint when authored lengths exceed the viewport.
    static func fraction(distance: Double, length: Double) -> Double {
        length > 0 ? min(0.5, distance / length) : 0
    }
}
