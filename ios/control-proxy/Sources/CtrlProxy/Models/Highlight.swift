import Foundation

public struct HighlightShape: Codable, Sendable {
    public enum Kind: String, Codable, Sendable { case circle }
    public let type: Kind
    public let bounds: HighlightBounds
    public init(type: Kind = .circle, bounds: HighlightBounds) {
        self.type = type
        self.bounds = bounds
    }
}

public struct HighlightBounds: Codable, Sendable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int
    public let sourceWidth: Int?
    public let sourceHeight: Int?

    public init(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        sourceWidth: Int? = nil,
        sourceHeight: Int? = nil
    ) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
    }
}
