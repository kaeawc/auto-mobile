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
                strokeWidth: shape.style?.strokeWidth ?? 3,
                dashPattern: shape.style?.dashPattern,
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
                strokeWidth: shape.style?.strokeWidth ?? 3,
                dashPattern: shape.style?.dashPattern,
                capStyle: shape.style?.capStyle ?? "round",
                joinStyle: shape.style?.joinStyle ?? "round"
            )
        default:
            throw HighlightOverlayError.unsupportedShape(shape.type)
        }
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
    #if canImport(UIKit) && canImport(QuartzCore)
        private var window: UIWindow?
        private var layers: [String: CAShapeLayer] = [:]
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
                let layer = self.layers[id] ?? CAShapeLayer()
                layer.fillColor = UIColor.clear.cgColor
                layer.strokeColor = UIColor(autoMobileHex: scaledCommand.strokeColor).cgColor
                layer.lineWidth = CGFloat(scaledCommand.strokeWidth)
                layer.lineDashPattern = scaledCommand.dashPattern?.map { NSNumber(value: $0) }
                layer.lineCap = scaledCommand.capStyle.caLineCap
                layer.lineJoin = scaledCommand.joinStyle.caLineJoin
                layer.path = Self.path(for: scaledCommand)
                if layer.superlayer == nil {
                    window.layer.addSublayer(layer)
                }
                self.layers[id] = layer
                rendered = true
            }

            if Thread.isMainThread {
                draw()
            } else {
                DispatchQueue.main.sync(execute: draw)
            }
            return rendered
        }

        public static func defaultLiveOverlayEnabled() -> Bool {
            let flag = ProcessInfo.processInfo.environment["AUTOMOBILE_IOS_LIVE_HIGHLIGHTS"]?.lowercased()
            if flag == "1" || flag == "true" || flag == "yes" {
                return true
            }
            return false
        }

        public func remove(id: String) {
            let removeLayer = {
                self.layers.removeValue(forKey: id)?.removeFromSuperlayer()
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

        private static func path(for command: HighlightOverlayRenderCommand) -> CGPath? {
            switch command.shapeType {
            case "box":
                guard let bounds = command.bounds else { return nil }
                return UIBezierPath(
                    roundedRect: CGRect(
                        x: CGFloat(bounds.x),
                        y: CGFloat(bounds.y),
                        width: CGFloat(bounds.width),
                        height: CGFloat(bounds.height)
                    ),
                    cornerRadius: 4
                ).cgPath
            case "circle":
                guard let bounds = command.bounds else { return nil }
                return UIBezierPath(
                    ovalIn: CGRect(
                        x: CGFloat(bounds.x),
                        y: CGFloat(bounds.y),
                        width: CGFloat(bounds.width),
                        height: CGFloat(bounds.height)
                    )
                ).cgPath
            case "path":
                let path = UIBezierPath()
                guard let first = command.points.first else { return nil }
                path.move(to: CGPoint(x: CGFloat(first.x), y: CGFloat(first.y)))
                for point in command.points.dropFirst() {
                    path.addLine(to: CGPoint(x: CGFloat(point.x), y: CGFloat(point.y)))
                }
                return path.cgPath
            default:
                return nil
            }
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
