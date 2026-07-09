#if DEBUG && !os(watchOS)
import Foundation
#if canImport(QuartzCore)
import QuartzCore
#endif
#if canImport(UIKit)
import UIKit
#endif

struct SdkHighlightShape: Codable {
    let type: String
    let bounds: SdkHighlightBounds?
    let points: [SdkHighlightPoint]?
    let style: SdkHighlightStyle?
}

struct SdkHighlightBounds: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let sourceWidth: Int?
    let sourceHeight: Int?
}

struct SdkHighlightPoint: Codable {
    let x: Float
    let y: Float
}

struct SdkHighlightStyle: Codable {
    let strokeColor: String?
    let strokeWidth: Float?
    let dashPattern: [Float]?
    let capStyle: String?
    let joinStyle: String?
}

struct SdkAddHighlightBody: Codable {
    let id: String
    let shape: SdkHighlightShape
}

struct SdkHighlightRenderCommand {
    let shapeType: String
    let bounds: SdkHighlightBounds?
    let points: [SdkHighlightPoint]
    let strokeColor: String
    let strokeWidth: Float
    let dashPattern: [Float]?
    let capStyle: String
    let joinStyle: String
}

struct SdkHighlightTargetSize {
    let width: Float
    let height: Float
}

enum SdkHighlightCommandBuilder {
    static func command(for shape: SdkHighlightShape) -> SdkHighlightRenderCommand? {
        switch shape.type {
        case "box", "circle":
            guard let bounds = shape.bounds, bounds.width > 0, bounds.height > 0 else { return nil }
            return SdkHighlightRenderCommand(
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
            guard let points = shape.points, points.count >= 2 else { return nil }
            return SdkHighlightRenderCommand(
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
            return nil
        }
    }
}

enum SdkHighlightCommandScaler {
    static func scaled(
        _ command: SdkHighlightRenderCommand,
        targetSize: SdkHighlightTargetSize
    ) -> SdkHighlightRenderCommand? {
        // The SDK draws into the target app's own view space, so device-coordinate
        // bounds MUST carry their source dimensions to be mapped correctly. Missing
        // source dims means we cannot place the highlight reliably — reject rather
        // than draw raw daemon-pixel coordinates and misplace the overlay (issue #2682).
        guard let bounds = command.bounds,
              let sourceWidth = bounds.sourceWidth,
              let sourceHeight = bounds.sourceHeight else {
            return nil
        }
        guard sourceWidth > 0,
              sourceHeight > 0,
              targetSize.width > 0,
              targetSize.height > 0 else {
            return nil
        }

        let scaleX = targetSize.width / Float(sourceWidth)
        let scaleY = targetSize.height / Float(sourceHeight)
        let scaledBounds = SdkHighlightBounds(
            x: Int((Float(bounds.x) * scaleX).rounded()),
            y: Int((Float(bounds.y) * scaleY).rounded()),
            width: Int((Float(bounds.width) * scaleX).rounded()),
            height: Int((Float(bounds.height) * scaleY).rounded()),
            sourceWidth: nil,
            sourceHeight: nil
        )
        let scaledPoints = command.points.map {
            SdkHighlightPoint(x: $0.x * scaleX, y: $0.y * scaleY)
        }

        return SdkHighlightRenderCommand(
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

struct SdkHighlightColorComponents: Equatable {
    let red: Double
    let green: Double
    let blue: Double
    let alpha: Double

    static func parse(hex: String) -> SdkHighlightColorComponents {
        let trimmed = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard let value = UInt64(trimmed, radix: 16) else {
            return SdkHighlightColorComponents(red: 0, green: 0, blue: 0, alpha: 1)
        }

        switch trimmed.count {
        case 8:
            return SdkHighlightColorComponents(
                red: Double((value & 0x00FF_0000) >> 16) / 255,
                green: Double((value & 0x0000_FF00) >> 8) / 255,
                blue: Double(value & 0x0000_00FF) / 255,
                alpha: Double((value & 0xFF00_0000) >> 24) / 255
            )
        default:
            return SdkHighlightColorComponents(
                red: Double((value & 0xFF0000) >> 16) / 255,
                green: Double((value & 0x00FF00) >> 8) / 255,
                blue: Double(value & 0x0000FF) / 255,
                alpha: 1
            )
        }
    }
}

#if canImport(UIKit)
final class SdkHighlightOverlayManager {
    static let shared = SdkHighlightOverlayManager()

    private var window: UIWindow?
    private var layers: [String: CAShapeLayer] = [:]
    private let ttlSeconds: TimeInterval

    init(ttlSeconds: TimeInterval = 3) {
        self.ttlSeconds = ttlSeconds
    }

    @discardableResult
    func show(id: String, shape: SdkHighlightShape) -> Bool {
        guard !id.isEmpty, let command = SdkHighlightCommandBuilder.command(for: shape) else {
            return false
        }

        var rendered = false
        let draw = {
            let window = self.ensureWindow()
            let targetSize = SdkHighlightTargetSize(
                width: Float(window.bounds.width),
                height: Float(window.bounds.height)
            )
            guard let scaledCommand = SdkHighlightCommandScaler.scaled(command, targetSize: targetSize) else {
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
        guard rendered else { return false }

        DispatchQueue.main.asyncAfter(deadline: .now() + ttlSeconds) { [weak self] in
            self?.remove(id: id)
        }
        return true
    }

    /// Test hook: the on-screen bounding box of the rendered highlight path for `id`,
    /// in the overlay window's coordinate space. Used by the Playground E2E test to
    /// assert the drawn overlay frame lands on the intended element (issue #2682).
    func renderedPathBounds(id: String) -> CGRect? {
        layers[id]?.path?.boundingBoxOfPath
    }

    /// Test hook: the overlay window size used as the scaling target.
    func renderTargetSize() -> CGSize? {
        window?.bounds.size
    }

    func remove(id: String) {
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

    private static func path(for command: SdkHighlightRenderCommand) -> CGPath? {
        switch command.shapeType {
        case "box":
            guard let bounds = command.bounds else { return nil }
            return UIBezierPath(
                roundedRect: CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height),
                cornerRadius: 4
            ).cgPath
        case "circle":
            guard let bounds = command.bounds else { return nil }
            return UIBezierPath(
                ovalIn: CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
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
}

private extension UIColor {
    convenience init(autoMobileHex hex: String) {
        let color = SdkHighlightColorComponents.parse(hex: hex)
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
#endif
