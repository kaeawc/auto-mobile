import Foundation
#if canImport(CoreGraphics)
    import CoreGraphics
#endif
#if canImport(QuartzCore)
    import QuartzCore
#endif
#if canImport(UIKit)
    import UIKit
#endif

public protocol HighlightOverlayManaging: AnyObject {
    @discardableResult
    func show(id: String, shape: HighlightShape) -> Bool
}

public protocol HighlightOverlayRendering: AnyObject {
    @discardableResult
    func render(id: String, command: HighlightOverlayRenderCommand) -> Bool
    func remove(id: String)
}

public protocol HighlightOverlayScheduling: AnyObject {
    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void)
}

public final class DispatchHighlightOverlayScheduler: HighlightOverlayScheduling {
    public init() {}

    public func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: block)
    }
}

public struct HighlightOverlayRenderCommand {
    public let shapeType: String
    public let bounds: HighlightBounds?
    public let points: [HighlightPoint]
    public let strokeColor: String
    public let strokeWidth: Float
    public let dashPattern: [Float]?
    public let smoothing: String?
    public let tension: Float?
    public let capStyle: String
    public let joinStyle: String
}

public enum HighlightOverlayError: Error, Equatable {
    case missingBounds(String)
    case missingPoints
    case unsupportedShape(String)
}

public struct HighlightOverlayTargetSize {
    public let width: Float
    public let height: Float

    public init(width: Float, height: Float) {
        self.width = width
        self.height = height
    }
}

public enum HighlightOverlayCommandScaler {
    public static func scaled(
        _ command: HighlightOverlayRenderCommand,
        targetSize: HighlightOverlayTargetSize?
    ) -> HighlightOverlayRenderCommand? {
        guard let bounds = command.bounds,
              let sourceWidth = bounds.sourceWidth,
              let sourceHeight = bounds.sourceHeight else {
            return command
        }
        guard let targetSize,
              sourceWidth > 0,
              sourceHeight > 0,
              targetSize.width > 0,
              targetSize.height > 0 else {
            return nil
        }

        let scaleX = targetSize.width / Float(sourceWidth)
        let scaleY = targetSize.height / Float(sourceHeight)
        let scaledBounds = HighlightBounds(
            x: Int((Float(bounds.x) * scaleX).rounded()),
            y: Int((Float(bounds.y) * scaleY).rounded()),
            width: Int((Float(bounds.width) * scaleX).rounded()),
            height: Int((Float(bounds.height) * scaleY).rounded())
        )
        let scaledPoints = command.points.map {
            HighlightPoint(x: $0.x * scaleX, y: $0.y * scaleY)
        }

        return HighlightOverlayRenderCommand(
            shapeType: command.shapeType,
            bounds: scaledBounds,
            points: scaledPoints,
            strokeColor: command.strokeColor,
            strokeWidth: command.strokeWidth,
            dashPattern: command.dashPattern,
            smoothing: command.smoothing,
            tension: command.tension,
            capStyle: command.capStyle,
            joinStyle: command.joinStyle
        )
    }
}

public struct HighlightOverlayColorComponents: Equatable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public static func parse(hex: String) -> HighlightOverlayColorComponents {
        let trimmed = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let scanner = Scanner(string: trimmed)
        var value: UInt64 = 0
        guard scanner.scanHexInt64(&value) else {
            return HighlightOverlayColorComponents(red: 0, green: 0, blue: 0, alpha: 1)
        }

        switch trimmed.count {
        case 8:
            return HighlightOverlayColorComponents(
                red: Double((value & 0x00FF_0000) >> 16) / 255,
                green: Double((value & 0x0000_FF00) >> 8) / 255,
                blue: Double(value & 0x0000_00FF) / 255,
                alpha: Double((value & 0xFF00_0000) >> 24) / 255
            )
        default:
            return HighlightOverlayColorComponents(
                red: Double((value & 0xFF0000) >> 16) / 255,
                green: Double((value & 0x00FF00) >> 8) / 255,
                blue: Double(value & 0x0000FF) / 255,
                alpha: 1
            )
        }
    }
}

public enum HighlightOverlayCommandBuilder {
    private static let defaultStrokeWidth: Float = 8
    private static let defaultPathTension: Float = 0.5

    public static func command(for shape: HighlightShape) throws -> HighlightOverlayRenderCommand {
        switch shape.type {
        case "box", "circle":
            guard let bounds = shape.bounds else {
                throw HighlightOverlayError.missingBounds(shape.type)
            }
            return HighlightOverlayRenderCommand(
                shapeType: shape.type,
                bounds: bounds,
                points: [],
                strokeColor: shape.style?.strokeColor ?? "#FF0000",
                strokeWidth: shape.style?.strokeWidth ?? defaultStrokeWidth,
                dashPattern: shape.style?.dashPattern,
                smoothing: shape.style?.smoothing,
                tension: shape.style?.tension ?? defaultPathTension,
                capStyle: shape.style?.capStyle ?? "round",
                joinStyle: shape.style?.joinStyle ?? "round"
            )
        case "path":
            guard let points = shape.points, points.count >= 2 else {
                throw HighlightOverlayError.missingPoints
            }
            return HighlightOverlayRenderCommand(
                shapeType: shape.type,
                bounds: shape.bounds,
                points: points,
                strokeColor: shape.style?.strokeColor ?? "#FF0000",
                strokeWidth: shape.style?.strokeWidth ?? defaultStrokeWidth,
                dashPattern: shape.style?.dashPattern,
                smoothing: shape.style?.smoothing,
                tension: shape.style?.tension ?? defaultPathTension,
                capStyle: shape.style?.capStyle ?? "round",
                joinStyle: shape.style?.joinStyle ?? "round"
            )
        default:
            throw HighlightOverlayError.unsupportedShape(shape.type)
        }
    }
}

public struct HighlightOverlayStrokeSegment: Equatable {
    public let startX: Float
    public let startY: Float
    public let endX: Float
    public let endY: Float
    public let strokeWidth: Float
}

public enum HighlightOverlayHandDrawnSegments {
    private static let ellipseSegmentCount = 160
    private static let ellipseJitterRatio: Float = 0.035
    private static let ellipseJitterFrequencyX = 2.3
    private static let ellipseJitterFrequencyY = 3.7
    private static let ellipseStartAngle: Float = -90
    private static let ellipseStartAngleJitter: Float = 8
    private static let ellipseMinWidthFactor: Float = 0.75
    private static let ellipseMaxWidthFactor: Float = 2.0
    private static let boxSegmentCount = 160
    private static let boxJitterRatio: Float = 0.025
    private static let pathMinSampleDistance: Float = 3
    private static let pathTaperFraction: Float = 0.12
    private static let pathMinWidthFactor: Float = 0.35
    private static let pathCurveTaperIntensity: Float = 0.35
    private static let minimumPointDistanceSquared: Float = 0.25

    public static func ellipseSegments(
        bounds: HighlightBounds,
        baseStrokeWidth: Float,
        phaseX: Double? = nil,
        phaseY: Double? = nil,
        startAngleJitter: Float? = nil
    ) -> [HighlightOverlayStrokeSegment] {
        guard bounds.width > 0, bounds.height > 0, baseStrokeWidth > 0 else { return [] }
        let centerX = Float(bounds.x) + Float(bounds.width) / 2
        let centerY = Float(bounds.y) + Float(bounds.height) / 2
        let radiusX = Float(bounds.width) / 2
        let radiusY = Float(bounds.height) / 2
        let sweep = 360 / Float(ellipseSegmentCount)
        let resolvedPhaseX = phaseX ?? Double.random(in: 0..<(Double.pi * 2))
        let resolvedPhaseY = phaseY ?? Double.random(in: 0..<(Double.pi * 2))
        let resolvedStartAngleJitter = startAngleJitter
            ?? Float.random(in: (-ellipseStartAngleJitter / 2)...(ellipseStartAngleJitter / 2))
        let startOffset = ellipseStartAngle + resolvedStartAngleJitter

        return (0..<ellipseSegmentCount).map { index in
            let startAngle = startOffset + Float(index) * sweep
            let endAngle = startAngle + sweep
            let midAngle = startAngle + sweep / 2
            let midRadians = Double(midAngle) * Double.pi / 180
            let jitterX = 1 + ellipseJitterRatio * Float(sin(midRadians * ellipseJitterFrequencyX + resolvedPhaseX))
            let jitterY = 1 + ellipseJitterRatio * Float(sin(midRadians * ellipseJitterFrequencyY + resolvedPhaseY))
            let start = pointOnEllipse(
                centerX: centerX,
                centerY: centerY,
                radiusX: radiusX * jitterX,
                radiusY: radiusY * jitterY,
                degrees: startAngle
            )
            let end = pointOnEllipse(
                centerX: centerX,
                centerY: centerY,
                radiusX: radiusX * jitterX,
                radiusY: radiusY * jitterY,
                degrees: endAngle
            )
            let widthFactor = ellipseWidthFactor(angleRadians: midRadians)
            return HighlightOverlayStrokeSegment(
                startX: start.x,
                startY: start.y,
                endX: end.x,
                endY: end.y,
                strokeWidth: baseStrokeWidth * widthFactor
            )
        }
    }

    public static func boxSegments(
        bounds: HighlightBounds,
        baseStrokeWidth: Float,
        phase: Double? = nil
    ) -> [HighlightOverlayStrokeSegment] {
        guard bounds.width > 0, bounds.height > 0, baseStrokeWidth > 0 else { return [] }
        let left = Float(bounds.x)
        let top = Float(bounds.y)
        let right = left + Float(bounds.width)
        let bottom = top + Float(bounds.height)
        let perimeter = 2 * (Float(bounds.width) + Float(bounds.height))
        guard perimeter > 0 else { return [] }

        let step = perimeter / Float(boxSegmentCount)
        let jitterAmplitude = min(Float(bounds.width), Float(bounds.height)) * boxJitterRatio
        let resolvedPhase = phase ?? Double.random(in: 0..<(Double.pi * 2))

        return (0..<boxSegmentCount).map { index in
            let startDistance = Float(index) * step
            let endDistance = startDistance + step
            let start = pointOnBox(
                distance: startDistance,
                left: left,
                top: top,
                right: right,
                bottom: bottom,
                jitterAmplitude: jitterAmplitude,
                phase: resolvedPhase
            )
            let end = pointOnBox(
                distance: endDistance,
                left: left,
                top: top,
                right: right,
                bottom: bottom,
                jitterAmplitude: jitterAmplitude,
                phase: resolvedPhase
            )
            let progress = ((startDistance + step / 2) / perimeter).clamped(to: 0...1)
            return HighlightOverlayStrokeSegment(
                startX: start.x,
                startY: start.y,
                endX: end.x,
                endY: end.y,
                strokeWidth: baseStrokeWidth * boxWidthFactor(progress: progress)
            )
        }
    }

    public static func pathSegments(
        points: [HighlightPoint],
        smoothing: String?,
        tension: Float?,
        baseStrokeWidth: Float
    ) -> [HighlightOverlayStrokeSegment] {
        guard points.count >= 2, baseStrokeWidth > 0 else { return [] }
        let filtered = filterClosePoints(points)
        guard filtered.count >= 2 else { return [] }
        let smoothed = smoothedPoints(
            filtered,
            smoothing: smoothing ?? "catmull-rom",
            tension: (tension ?? 0.5).clamped(to: 0...1)
        )
        guard smoothed.count >= 2 else { return [] }

        let lengths = segmentLengths(smoothed)
        let totalLength = lengths.reduce(0, +)
        guard totalLength > 0 else { return [] }

        var distance: Float = 0
        var segments: [HighlightOverlayStrokeSegment] = []
        for index in 0..<(smoothed.count - 1) {
            let start = smoothed[index]
            let end = smoothed[index + 1]
            let length = lengths[index]
            guard length > 0 else { continue }
            let previous = index > 0 ? vector(from: smoothed[index - 1], to: start) : vector(from: start, to: end)
            let current = vector(from: start, to: end)
            let progress = ((distance + length / 2) / totalLength).clamped(to: 0...1)
            let widthFactor = pathWidthFactor(progress: progress, previous: previous, current: current)
            segments.append(
                HighlightOverlayStrokeSegment(
                    startX: start.x,
                    startY: start.y,
                    endX: end.x,
                    endY: end.y,
                    strokeWidth: baseStrokeWidth * widthFactor
                )
            )
            distance += length
        }
        return segments
    }

    private static func pointOnBox(
        distance: Float,
        left: Float,
        top: Float,
        right: Float,
        bottom: Float,
        jitterAmplitude: Float,
        phase: Double
    ) -> (x: Float, y: Float) {
        let width = right - left
        let height = bottom - top
        let perimeter = 2 * (width + height)
        let wrappedDistance = distance.truncatingRemainder(dividingBy: perimeter)
        let jitter = jitterAmplitude * Float(sin(Double(wrappedDistance) * 0.11 + phase))

        if wrappedDistance <= width {
            return (x: left + wrappedDistance, y: top + jitter)
        }
        if wrappedDistance <= width + height {
            return (x: right + jitter, y: top + (wrappedDistance - width))
        }
        if wrappedDistance <= (2 * width) + height {
            return (x: right - (wrappedDistance - width - height), y: bottom + jitter)
        }
        return (x: left + jitter, y: bottom - (wrappedDistance - (2 * width) - height))
    }

    private static func boxWidthFactor(progress: Float) -> Float {
        ellipseMinWidthFactor + (ellipseMaxWidthFactor - ellipseMinWidthFactor) * Float(abs(sin(Double(progress) * Double.pi * 2)))
    }

    private static func pointOnEllipse(
        centerX: Float,
        centerY: Float,
        radiusX: Float,
        radiusY: Float,
        degrees: Float
    ) -> (x: Float, y: Float) {
        let radians = Double(degrees) * Double.pi / 180
        return (
            x: centerX + radiusX * Float(cos(radians)),
            y: centerY + radiusY * Float(sin(radians))
        )
    }

    private static func ellipseWidthFactor(angleRadians: Double) -> Float {
        let variation = abs(Float(sin(angleRadians)))
        return ellipseMinWidthFactor + (ellipseMaxWidthFactor - ellipseMinWidthFactor) * variation
    }

    private static func smoothedPoints(
        _ points: [HighlightPoint],
        smoothing: String,
        tension: Float
    ) -> [HighlightPoint] {
        switch smoothing {
        case "none", "douglas-peucker":
            return points
        case "bezier":
            return sampleBezier(points, tension: tension)
        default:
            return sampleCatmullRom(points, tension: tension)
        }
    }

    private static func sampleCatmullRom(_ points: [HighlightPoint], tension: Float) -> [HighlightPoint] {
        var sampled = [points[0]]
        for index in 0..<(points.count - 1) {
            let p0 = index > 0 ? points[index - 1] : points[index]
            let p1 = points[index]
            let p2 = points[index + 1]
            let p3 = index + 2 < points.count ? points[index + 2] : p2
            let cp1 = HighlightPoint(
                x: p1.x + (p2.x - p0.x) * tension / 6,
                y: p1.y + (p2.y - p0.y) * tension / 6
            )
            let cp2 = HighlightPoint(
                x: p2.x - (p3.x - p1.x) * tension / 6,
                y: p2.y - (p3.y - p1.y) * tension / 6
            )
            appendCubicSamples(to: &sampled, p0: p1, cp1: cp1, cp2: cp2, p1: p2)
        }
        return sampled
    }

    private static func sampleBezier(_ points: [HighlightPoint], tension: Float) -> [HighlightPoint] {
        guard points.count > 2 else { return points }
        var sampled = [points[0]]
        for index in 1..<(points.count - 1) {
            let current = points[index]
            let next = points[index + 1]
            let mid = HighlightPoint(x: (current.x + next.x) / 2, y: (current.y + next.y) / 2)
            let end = HighlightPoint(
                x: current.x + (mid.x - current.x) * tension,
                y: current.y + (mid.y - current.y) * tension
            )
            appendQuadraticSamples(to: &sampled, p0: sampled.last ?? current, cp: current, p1: end)
        }
        sampled.append(points[points.count - 1])
        return sampled
    }

    private static func appendCubicSamples(
        to sampled: inout [HighlightPoint],
        p0: HighlightPoint,
        cp1: HighlightPoint,
        cp2: HighlightPoint,
        p1: HighlightPoint
    ) {
        let samples = max(2, Int(distance(from: p0, to: p1) / pathMinSampleDistance))
        for step in 1...samples {
            let t = Float(step) / Float(samples)
            let inv = 1 - t
            sampled.append(
                HighlightPoint(
                    x: inv * inv * inv * p0.x + 3 * inv * inv * t * cp1.x + 3 * inv * t * t * cp2.x + t * t * t * p1.x,
                    y: inv * inv * inv * p0.y + 3 * inv * inv * t * cp1.y + 3 * inv * t * t * cp2.y + t * t * t * p1.y
                )
            )
        }
    }

    private static func appendQuadraticSamples(
        to sampled: inout [HighlightPoint],
        p0: HighlightPoint,
        cp: HighlightPoint,
        p1: HighlightPoint
    ) {
        let samples = max(2, Int(distance(from: p0, to: p1) / pathMinSampleDistance))
        for step in 1...samples {
            let t = Float(step) / Float(samples)
            let inv = 1 - t
            sampled.append(
                HighlightPoint(
                    x: inv * inv * p0.x + 2 * inv * t * cp.x + t * t * p1.x,
                    y: inv * inv * p0.y + 2 * inv * t * cp.y + t * t * p1.y
                )
            )
        }
    }

    private static func filterClosePoints(_ points: [HighlightPoint]) -> [HighlightPoint] {
        guard points.count > 2 else { return points }
        var filtered = [points[0]]
        var lastKept = points[0]
        for point in points.dropFirst().dropLast() {
            if distanceSquared(from: lastKept, to: point) >= minimumPointDistanceSquared {
                filtered.append(point)
                lastKept = point
            }
        }
        let last = points[points.count - 1]
        if distanceSquared(from: lastKept, to: last) >= minimumPointDistanceSquared || filtered.count == 1 {
            filtered.append(last)
        } else {
            filtered[filtered.count - 1] = last
        }
        return filtered
    }

    private static func segmentLengths(_ points: [HighlightPoint]) -> [Float] {
        (0..<(points.count - 1)).map { distance(from: points[$0], to: points[$0 + 1]) }
    }

    private static func pathWidthFactor(
        progress: Float,
        previous: (x: Float, y: Float),
        current: (x: Float, y: Float)
    ) -> Float {
        max(pathMinWidthFactor, taperFactor(progress: progress) * curveFactor(previous: previous, current: current))
    }

    private static func taperFactor(progress: Float) -> Float {
        guard pathTaperFraction > 0 else { return 1 }
        let start = min(1, progress / pathTaperFraction)
        let end = min(1, (1 - progress) / pathTaperFraction)
        let taper = min(start, end)
        return taper * taper * (3 - 2 * taper)
    }

    private static func curveFactor(previous: (x: Float, y: Float), current: (x: Float, y: Float)) -> Float {
        let previousMagnitude = sqrt(previous.x * previous.x + previous.y * previous.y)
        let currentMagnitude = sqrt(current.x * current.x + current.y * current.y)
        guard previousMagnitude > 0, currentMagnitude > 0 else { return 1 }
        let previousX = previous.x / previousMagnitude
        let previousY = previous.y / previousMagnitude
        let currentX = current.x / currentMagnitude
        let currentY = current.y / currentMagnitude
        let dot = (previousX * currentX + previousY * currentY).clamped(to: -1...1)
        let curvature = (1 - dot) / 2
        return 1 - min(1, curvature) * pathCurveTaperIntensity
    }

    private static func vector(from start: HighlightPoint, to end: HighlightPoint) -> (x: Float, y: Float) {
        (x: end.x - start.x, y: end.y - start.y)
    }

    private static func distance(from start: HighlightPoint, to end: HighlightPoint) -> Float {
        sqrt(distanceSquared(from: start, to: end))
    }

    private static func distanceSquared(from start: HighlightPoint, to end: HighlightPoint) -> Float {
        let dx = end.x - start.x
        let dy = end.y - start.y
        return dx * dx + dy * dy
    }
}

private extension Float {
    func clamped(to range: ClosedRange<Float>) -> Float {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

public final class HighlightOverlayManager: HighlightOverlayManaging {
    private let renderer: HighlightOverlayRendering
    private let scheduler: HighlightOverlayScheduling
    private let ttlSeconds: TimeInterval

    public init(
        renderer: HighlightOverlayRendering = DefaultHighlightOverlayRenderer(),
        scheduler: HighlightOverlayScheduling = DispatchHighlightOverlayScheduler(),
        ttlSeconds: TimeInterval = 3
    ) {
        self.renderer = renderer
        self.scheduler = scheduler
        self.ttlSeconds = ttlSeconds
    }

    @discardableResult
    public func show(id: String, shape: HighlightShape) -> Bool {
        guard !id.isEmpty else { return false }
        guard let command = try? HighlightOverlayCommandBuilder.command(for: shape) else { return false }
        guard renderer.render(id: id, command: command) else { return false }
        scheduler.schedule(after: ttlSeconds) { [weak self] in
            self?.renderer.remove(id: id)
        }
        return true
    }
}

public final class DefaultHighlightOverlayRenderer: HighlightOverlayRendering {
    public static func defaultLiveOverlayEnabled() -> Bool {
        liveOverlayEnabled(environment: ProcessInfo.processInfo.environment)
    }

    public static func liveOverlayEnabled(environment: [String: String]) -> Bool {
        let flag = environment["AUTOMOBILE_IOS_LIVE_HIGHLIGHTS"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if flag == "0" || flag == "false" || flag == "no" {
            return false
        }
        if flag == "1" || flag == "true" || flag == "yes" {
            return true
        }
        return true
    }

    #if canImport(UIKit) && canImport(QuartzCore)
        private var window: UIWindow?
        private var layers: [String: [CAShapeLayer]] = [:]
        private let liveOverlayEnabled: () -> Bool

        public init(liveOverlayEnabled: @escaping () -> Bool = DefaultHighlightOverlayRenderer.defaultLiveOverlayEnabled) {
            self.liveOverlayEnabled = liveOverlayEnabled
        }

        @discardableResult
        public func render(id: String, command: HighlightOverlayRenderCommand) -> Bool {
            guard liveOverlayEnabled() else { return false }
            var rendered = false
            let draw = {
                let window = self.ensureWindow()
                let targetSize = HighlightOverlayTargetSize(
                    width: Float(window.bounds.width),
                    height: Float(window.bounds.height)
                )
                guard let scaledCommand = HighlightOverlayCommandScaler.scaled(command, targetSize: targetSize) else {
                    return
                }
                self.layers.removeValue(forKey: id)?.forEach { $0.removeFromSuperlayer() }
                let segmentLayers = Self.segmentLayers(for: scaledCommand)
                guard !segmentLayers.isEmpty else {
                    return
                }
                segmentLayers.enumerated().forEach { index, layer in
                    window.layer.addSublayer(layer)
                    Self.animate(layer: layer, index: index, total: segmentLayers.count)
                }
                self.layers[id] = segmentLayers
                rendered = true
            }

            if Thread.isMainThread {
                draw()
            } else {
                DispatchQueue.main.sync(execute: draw)
            }
            return rendered
        }

        public func remove(id: String) {
            let removeLayer = {
                self.layers.removeValue(forKey: id)?.forEach { $0.removeFromSuperlayer() }
                if self.layers.isEmpty {
                    self.window?.isHidden = true
                    self.window = nil
                }
            }
            if Thread.isMainThread {
                removeLayer()
            } else {
                DispatchQueue.main.async(execute: removeLayer)
            }
        }

        private func ensureWindow() -> UIWindow {
            if let window { return window }
            let newWindow: UIWindow
            if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
                newWindow = UIWindow(windowScene: scene)
            } else {
                newWindow = UIWindow(frame: UIScreen.main.bounds)
            }
            newWindow.windowLevel = .alert + 1
            newWindow.isUserInteractionEnabled = false
            newWindow.backgroundColor = .clear
            let rootViewController = UIViewController()
            rootViewController.view.backgroundColor = .clear
            newWindow.rootViewController = rootViewController
            newWindow.isHidden = false
            window = newWindow
            return newWindow
        }

        private static func segmentLayers(for command: HighlightOverlayRenderCommand) -> [CAShapeLayer] {
            let segments: [HighlightOverlayStrokeSegment]
            switch command.shapeType {
            case "box":
                guard let bounds = command.bounds else { return [] }
                segments = HighlightOverlayHandDrawnSegments.boxSegments(
                    bounds: bounds,
                    baseStrokeWidth: command.strokeWidth
                )
            case "circle":
                guard let bounds = command.bounds else { return [] }
                segments = HighlightOverlayHandDrawnSegments.ellipseSegments(
                    bounds: bounds,
                    baseStrokeWidth: command.strokeWidth
                )
            case "path":
                segments = HighlightOverlayHandDrawnSegments.pathSegments(
                    points: command.points,
                    smoothing: command.smoothing,
                    tension: command.tension,
                    baseStrokeWidth: command.strokeWidth
                )
            default:
                return []
            }
            return segments.map { segment in
                let path = UIBezierPath()
                path.move(to: CGPoint(x: CGFloat(segment.startX), y: CGFloat(segment.startY)))
                path.addLine(to: CGPoint(x: CGFloat(segment.endX), y: CGFloat(segment.endY)))

                let layer = CAShapeLayer()
                layer.fillColor = UIColor.clear.cgColor
                layer.strokeColor = UIColor(autoMobileHex: command.strokeColor).cgColor
                layer.lineWidth = CGFloat(segment.strokeWidth)
                layer.lineDashPattern = command.dashPattern?.map { NSNumber(value: $0) }
                layer.lineCap = command.capStyle.caLineCap
                layer.lineJoin = command.joinStyle.caLineJoin
                layer.path = path.cgPath
                layer.strokeEnd = 1
                layer.opacity = 1
                return layer
            }
        }

        private static func animate(layer: CAShapeLayer, index: Int, total: Int) {
            let drawDuration = 0.5
            let displayDuration = 0.5
            let fadeDuration = 0.2
            let segmentDelay = total > 1 ? drawDuration * 0.95 * Double(index) / Double(total - 1) : 0

            let drawAnimation = CABasicAnimation(keyPath: "strokeEnd")
            drawAnimation.fromValue = 0
            drawAnimation.toValue = 1
            drawAnimation.duration = max(0.02, drawDuration - segmentDelay)
            drawAnimation.beginTime = CACurrentMediaTime() + segmentDelay
            drawAnimation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            drawAnimation.fillMode = .backwards
            drawAnimation.isRemovedOnCompletion = true
            layer.add(drawAnimation, forKey: "autoMobileDraw")

            let fadeAnimation = CABasicAnimation(keyPath: "opacity")
            fadeAnimation.fromValue = 1
            fadeAnimation.toValue = 0
            fadeAnimation.duration = fadeDuration
            fadeAnimation.beginTime = CACurrentMediaTime() + drawDuration + displayDuration + segmentDelay * 0.2
            fadeAnimation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            fadeAnimation.fillMode = .forwards
            fadeAnimation.isRemovedOnCompletion = false
            layer.add(fadeAnimation, forKey: "autoMobileFade")
        }
    #else
        public init() {}

        @discardableResult
        public func render(id _: String, command _: HighlightOverlayRenderCommand) -> Bool {
            false
        }

        public func remove(id _: String) {}
    #endif
}

#if canImport(UIKit)
    private extension UIColor {
        convenience init(autoMobileHex hex: String) {
            let color = HighlightOverlayColorComponents.parse(hex: hex)
            self.init(
                red: CGFloat(color.red),
                green: CGFloat(color.green),
                blue: CGFloat(color.blue),
                alpha: CGFloat(color.alpha)
            )
        }
    }

    private extension String {
        var caLineCap: CAShapeLayerLineCap {
            switch self {
            case "butt": return .butt
            case "square": return .square
            default: return .round
            }
        }

        var caLineJoin: CAShapeLayerLineJoin {
            switch self {
            case "miter": return .miter
            case "bevel": return .bevel
            default: return .round
            }
        }
    }
#endif
