import Foundation

// MARK: - Highlight Models
//
// A highlight is a shape (box or path) composed of bounds / points / style. These
// four types are a single tightly-coupled family — a `HighlightShape` is defined
// in terms of the other three — so they share a file (the "very closely related
// types" exception to one-type-per-file). Referenced by `RequestAddHighlight`.

public struct HighlightShape: Codable, Sendable {
    public let type: String // "box" or "path"
    public let bounds: HighlightBounds?
    public let points: [HighlightPoint]?
    public let style: HighlightStyle?

    public init(
        type: String,
        bounds: HighlightBounds? = nil,
        points: [HighlightPoint]? = nil,
        style: HighlightStyle? = nil
    ) {
        self.type = type
        self.bounds = bounds
        self.points = points
        self.style = style
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

public struct HighlightPoint: Codable, Sendable {
    public let x: Float
    public let y: Float

    public init(x: Float, y: Float) {
        self.x = x
        self.y = y
    }
}

public struct HighlightStyle: Codable, Sendable {
    public let strokeColor: String?
    public let strokeWidth: Float?
    public let dashPattern: [Float]?
    public let smoothing: String?
    public let tension: Float?
    public let capStyle: String?
    public let joinStyle: String?

    public init(
        strokeColor: String? = nil,
        strokeWidth: Float? = nil,
        dashPattern: [Float]? = nil,
        smoothing: String? = nil,
        tension: Float? = nil,
        capStyle: String? = nil,
        joinStyle: String? = nil
    ) {
        self.strokeColor = strokeColor
        self.strokeWidth = strokeWidth
        self.dashPattern = dashPattern
        self.smoothing = smoothing
        self.tension = tension
        self.capStyle = capStyle
        self.joinStyle = joinStyle
    }
}
