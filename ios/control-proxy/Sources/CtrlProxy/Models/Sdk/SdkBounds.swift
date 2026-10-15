import Foundation

/// Element bounds in root view coordinates (matches SDK format).
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
