import Foundation

/// Element bounds (matching Android's ElementBounds).
public struct ElementBounds: Codable, Sendable {
    public let left: Int
    public let top: Int
    public let right: Int
    public let bottom: Int

    public init(left: Int, top: Int, right: Int, bottom: Int) {
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom
    }

    /// Clamp snapshot coordinates so invalid lock-screen frames cannot trap integer conversion.
    public init(clamping frame: CGRect) {
        self.init(
            left: Self.clampedInt(frame.origin.x),
            top: Self.clampedInt(frame.origin.y),
            right: Self.clampedInt(frame.origin.x + frame.width),
            bottom: Self.clampedInt(frame.origin.y + frame.height)
        )
    }

    /// Map NaN to zero and clamp to +/-Int32.max, preserving truncation for normal coordinates.
    public static func clampedInt(_ value: CGFloat) -> Int {
        guard !value.isNaN else { return 0 }
        let limit = Int(Int32.max)
        if value >= CGFloat(limit) { return limit }
        if value <= -CGFloat(limit) { return -limit }
        return Int(value)
    }

    public var width: Int {
        BoundsArithmetic.signedDifference(right, left)
    }

    public var height: Int {
        BoundsArithmetic.signedDifference(bottom, top)
    }

    public var centerX: Int {
        // Half the saturated signed extent, truncated toward zero. This remains
        // between the endpoints, so adding it to the origin cannot overflow.
        left + width / 2
    }

    public var centerY: Int {
        // As for centerX, including inverted and overflowing extents.
        top + height / 2
    }
}

/// Shared by the two bounds models; no decoding clamp or endpoint normalization.
/// Keep this arithmetic adjacent to bounds rather than adding a generic Int API.
enum BoundsArithmetic {
    /// Preserve signed extents, saturating only an unrepresentable subtraction
    /// to Int.min or Int.max according to the mathematical result's sign.
    static func signedDifference(_ end: Int, _ start: Int) -> Int {
        let (difference, overflow) = end.subtractingReportingOverflow(start)
        return overflow ? (end < start ? Int.min : Int.max) : difference
    }
}
