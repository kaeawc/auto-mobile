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

    public var width: Int {
        right - left
    }

    public var height: Int {
        bottom - top
    }

    public var centerX: Int {
        left + width / 2
    }

    public var centerY: Int {
        top + height / 2
    }
}
