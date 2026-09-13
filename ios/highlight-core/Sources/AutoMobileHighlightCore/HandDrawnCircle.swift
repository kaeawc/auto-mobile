import CoreGraphics
import Foundation
import QuartzCore

public struct CircleHighlight: Codable {
    public enum Kind: String, Codable { case circle }
    public let type: Kind
    public let bounds: CircleBounds
    public init(type: Kind = .circle, bounds: CircleBounds) {
        self.type = type; self.bounds = bounds
    }
}

public struct CircleBounds: Codable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int
    public let sourceWidth: Int?
    public let sourceHeight: Int?
    public init(x: Int, y: Int, width: Int, height: Int, sourceWidth: Int?, sourceHeight: Int?) {
        self.x = x; self.y = y; self.width = width; self.height = height
        self.sourceWidth = sourceWidth; self.sourceHeight = sourceHeight
    }

    public func scaled(to size: CGSize) -> CGRect? {
        guard width > 0, height > 0, let sourceWidth, let sourceHeight,
              sourceWidth > 0, sourceHeight > 0, size.width > 0, size.height > 0 else { return nil }
        return CGRect(
            x: CGFloat(x) * size.width / CGFloat(sourceWidth),
            y: CGFloat(y) * size.height / CGFloat(sourceHeight),
            width: CGFloat(width) * size.width / CGFloat(sourceWidth),
            height: CGFloat(height) * size.height / CGFloat(sourceHeight)
        )
    }
}

/// Matches Android OverlayDrawer's 64 arcs, wobble, pressure variation and timing.
/// Geometry is randomized once; callers can inject fixed samples for tests.
public struct HandDrawnCircle {
    public static let duration: TimeInterval = 1.2
    public let phaseX: Double
    public let phaseY: Double
    public let startAngle: Double
    public init(random: () -> Double = { Double.random(in: 0 ..< 1) }) {
        phaseX = random() * .pi * 2
        phaseY = random() * .pi * 2
        startAngle = -90 + (random() - 0.5) * 8
    }

    public struct Segment {
        public let path: CGPath
        public let strokeWidth: CGFloat
    }

    public func segments(in rect: CGRect) -> [Segment] {
        (0 ..< 64).map { index in
            let start = (startAngle + Double(index) * 360 / 64) * .pi / 180
            let sweep = 2 * Double.pi / 64
            let mid = start + sweep / 2
            let radiusX = rect.width / 2 * (1 + 0.035 * sin(mid * 2.3 + phaseX))
            let radiusY = rect.height / 2 * (1 + 0.035 * sin(mid * 3.7 + phaseY))
            let path = CGMutablePath()
            let transform = CGAffineTransform(a: radiusX, b: 0, c: 0, d: radiusY, tx: rect.midX, ty: rect.midY)
            path.addArc(
                center: .zero,
                radius: 1,
                startAngle: start,
                endAngle: start + sweep,
                clockwise: false,
                transform: transform
            )
            return Segment(path: path, strokeWidth: 8 * (0.75 + 1.25 * abs(sin(mid))))
        }
    }

    public static func animation(elapsed: TimeInterval) -> (progress: CGFloat, alpha: Float) {
        let time = min(1, max(0, elapsed / duration))
        let progress = (1 - cos(.pi * time)) / 2
        if progress <= 5.0 / 12 {
            return (CGFloat((1 - cos(.pi * progress / (5.0 / 12))) / 2), 1)
        }
        if progress <= 10.0 / 12 {
            return (1, 1)
        }
        return (1, Float(max(0, (1 - progress) / (2.0 / 12))))
    }

    public static func segmentAlpha(_ index: Int, alpha: Float) -> Float {
        if alpha >= 1 {
            return 1
        }
        let start = Float(index) / 63 * 0.95
        return 1 - min(1, max(0, (1 - alpha - start) / 0.05))
    }
}

/// Shared renderer for UIKit and the macOS Simulator overlay. Geometry uses a
/// top-left origin; the AppKit caller flips this layer as a whole.
public final class HandDrawnCircleLayer: CALayer {
    private let circle: HandDrawnCircle
    private let strokes: [CAShapeLayer]
    override public init() {
        circle = HandDrawnCircle()
        strokes = (0 ..< 64).map { _ in CAShapeLayer() }
        super.init()
        for stroke in strokes {
            stroke.fillColor = nil
            stroke.strokeColor = CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
            stroke.lineCap = .round
            stroke.lineJoin = .round
            addSublayer(stroke)
        }
    }

    override public init(layer: Any) {
        circle = HandDrawnCircle(); strokes = []
        super.init(layer: layer)
    }

    public required init?(coder _: NSCoder) {
        nil
    }

    public func configure(rect: CGRect, strokeScale: CGFloat) {
        for (stroke, segment) in zip(strokes, circle.segments(in: rect)) {
            stroke.path = segment.path
            stroke.lineWidth = segment.strokeWidth * strokeScale
        }
    }

    public func update(elapsed: TimeInterval) {
        let state = HandDrawnCircle.animation(elapsed: elapsed)
        for (index, stroke) in strokes.enumerated() {
            stroke.strokeEnd = min(1, max(0, state.progress * 64 - CGFloat(index)))
            stroke.opacity = HandDrawnCircle.segmentAlpha(index, alpha: state.alpha)
        }
    }
}
