import Foundation

/// Signed-extent arithmetic shared by the bounds models; no decoding clamp or endpoint
/// normalization. Keep it adjacent to bounds rather than adding a generic Int API.
public enum BoundsArithmetic {
    /// Preserve signed extents, saturating only an unrepresentable subtraction
    /// to Int.min or Int.max according to the mathematical result's sign.
    public static func signedDifference(_ end: Int, _ start: Int) -> Int {
        let (difference, overflow) = end.subtractingReportingOverflow(start)
        return overflow ? (end < start ? Int.min : Int.max) : difference
    }
}

/// Element bounds in root view coordinates.
public struct SdkBounds: Codable, Sendable, Hashable {
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

    /// Signed extents saturate by sign on overflow, retaining inverted bounds.
    public var width: Int { BoundsArithmetic.signedDifference(right, left) }
    public var height: Int { BoundsArithmetic.signedDifference(bottom, top) }
}
