import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Finds the simulated display inside Xcode 27's Device Hub window.
///
/// Device Hub shows a foldable such as the Duo as one window for both panels. Its accessibility
/// groups for the panels do not describe where the panel is drawn: their frames lie outside the
/// window and stay unchanged when the zoom changes. So the placement comes from the pixels. The
/// detail area is bounded with the accessibility tree (sidebar edge, toolbar, control row), the
/// drawn device is the non-background bounding box inside it, and the display is the device
/// bounds minus the bezel.
enum DeviceHubDisplayLocator {
    /// Bezel thickness around the display in the display's own points, measured on the Duo at
    /// two zoom levels: the drawn device is `(display + 2 * bezel) * zoom` wide.
    static let bezelPoints: CGFloat = 20.5
    /// Longest display edge, in points, of any panel Device Hub draws today (the Duo inner panel is
    /// 951). A source longer than this is in pixels of a 2x or 3x capture.
    static let maxDisplayPointsLongEdge: CGFloat = 1000
    /// Per-channel sum of absolute differences from the background that counts as drawn.
    static let backgroundTolerance = 40
    /// Gap kept between the control row and the searched region, in points.
    static let controlsGap: CGFloat = 4

    struct AccessibilityLayout: Equatable {
        var splitterX: CGFloat?
        var toolbarMaxY: CGFloat?
        var controlsMinY: CGFloat?
    }

    /// RGBA pixels, 4 bytes each, `bytesPerRow` apart.
    struct PixelBuffer {
        let width: Int
        let height: Int
        let bytesPerRow: Int
        let bytes: [UInt8]
    }

    /// The area of the window, in window points, where Device Hub draws the device.
    static func detailRegion(windowFrame: CGRect, layout: AccessibilityLayout) -> CGRect? {
        guard let splitterX = layout.splitterX, let toolbarMaxY = layout.toolbarMaxY else { return nil }
        let bottom = (layout.controlsMinY ?? windowFrame.maxY) - controlsGap
        let region = CGRect(
            x: splitterX,
            y: toolbarMaxY,
            width: windowFrame.maxX - splitterX,
            height: bottom - toolbarMaxY
        )
        guard region.width > 0, region.height > 0, windowFrame.contains(region) else { return nil }
        return region.offsetBy(dx: -windowFrame.minX, dy: -windowFrame.minY)
    }

    /// Bounding box, in points relative to the window, of everything in `region` that differs from
    /// the background colour taken at the region's top-left corner.
    static func drawnBounds(in pixels: PixelBuffer, region: CGRect, windowSize: CGSize) -> CGRect? {
        guard windowSize.width > 0, windowSize.height > 0, pixels.width > 0, pixels.height > 0 else { return nil }
        let scaleX = CGFloat(pixels.width) / windowSize.width
        let scaleY = CGFloat(pixels.height) / windowSize.height
        let minX = max(0, Int((region.minX * scaleX).rounded(.down)))
        let maxX = min(pixels.width, Int((region.maxX * scaleX).rounded(.up)))
        let minY = max(0, Int((region.minY * scaleY).rounded(.down)))
        let maxY = min(pixels.height, Int((region.maxY * scaleY).rounded(.up)))
        guard minX + 2 < maxX, minY + 2 < maxY else { return nil }
        let background = rgb(pixels, x: minX + 2, y: minY + 2)
        var found: (minX: Int, minY: Int, maxX: Int, maxY: Int)?
        for y in minY ..< maxY {
            for x in minX ..< maxX where differs(rgb(pixels, x: x, y: y), background) {
                if let box = found {
                    found = (min(box.minX, x), min(box.minY, y), max(box.maxX, x), max(box.maxY, y))
                } else {
                    found = (x, y, x, y)
                }
            }
        }
        guard let box = found else { return nil }
        return CGRect(
            x: CGFloat(box.minX) / scaleX,
            y: CGFloat(box.minY) / scaleY,
            width: CGFloat(box.maxX - box.minX + 1) / scaleX,
            height: CGFloat(box.maxY - box.minY + 1) / scaleY
        )
    }

    /// `sourceSize` in display points: the smallest whole scale from 1 to 3 that brings the long edge
    /// within `maxDisplayPointsLongEdge`. The bezel is fixed in points, so the display must be too;
    /// otherwise the same bounds sent as screenshot pixels would be placed differently.
    static func pointSize(of sourceSize: CGSize) -> CGSize {
        let longEdge = max(sourceSize.width, sourceSize.height)
        let scale = (1 ... 3).first { longEdge / CGFloat($0) <= maxDisplayPointsLongEdge } ?? 3
        return CGSize(width: sourceSize.width / CGFloat(scale), height: sourceSize.height / CGFloat(scale))
    }

    /// The display inside the drawn device. With the source size, the zoom follows from the
    /// device width; the display keeps the source aspect, in the orientation Device Hub drew.
    static func displayRect(deviceBounds: CGRect, sourceSize: CGSize?) -> CGRect? {
        guard deviceBounds.width > 0, deviceBounds.height > 0 else { return nil }
        guard let rawSize = sourceSize, rawSize.width > 0, rawSize.height > 0 else { return nil }
        let sourceSize = pointSize(of: rawSize)
        let drawnLandscape = deviceBounds.width > deviceBounds.height
        let sourceLandscape = sourceSize.width > sourceSize.height
        let oriented = drawnLandscape == sourceLandscape
            ? sourceSize
            : CGSize(width: sourceSize.height, height: sourceSize.width)
        let zoom = deviceBounds.width / (oriented.width + 2 * bezelPoints)
        let size = CGSize(width: oriented.width * zoom, height: oriented.height * zoom)
        guard size.width > 0, size.height > 0 else { return nil }
        return CGRect(
            x: deviceBounds.midX - size.width / 2,
            y: deviceBounds.midY - size.height / 2,
            width: size.width,
            height: size.height
        )
    }

    /// Display rectangle in window points, or nil when Device Hub's layout cannot be read.
    static func locate(window: SimulatorOverlayTarget, sourceSize: CGSize?) async -> CGRect? {
        guard let sourceSize,
              let element = SimulatorDisplayGeometry.windowElement(window),
              let region = detailRegion(
                  windowFrame: window.frame,
                  layout: accessibilityLayout(of: element)
              ),
              let pixels = await capture(window: window),
              let bounds = drawnBounds(in: pixels, region: region, windowSize: window.frame.size)
        else { return nil }
        return displayRect(deviceBounds: bounds, sourceSize: sourceSize)
    }

    static func accessibilityLayout(of window: AXUIElement) -> AccessibilityLayout {
        var layout = AccessibilityLayout()
        var visited = 0
        func walk(_ element: AXUIElement, depth: Int) {
            visited += 1
            guard visited < 400, depth < 12 else { return }
            let role = SimulatorDisplayGeometry.attribute(element, kAXRoleAttribute) as? String
            // The sidebar lists every simulator; nothing there places the display.
            if role == kAXScrollAreaRole || role == kAXOutlineRole { return }
            let frame = SimulatorDisplayGeometry.frame(element)
            if role == kAXToolbarRole, let frame { layout.toolbarMaxY = frame.maxY }
            if role == kAXSplitterRole, let frame { layout.splitterX = frame.minX }
            if role == kAXButtonRole,
               SimulatorDisplayGeometry.attribute(element, kAXDescriptionAttribute) as? String == "Home",
               let frame { layout.controlsMinY = frame.minY }
            for child in SimulatorDisplayGeometry.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
                walk(child, depth: depth + 1)
            }
        }
        walk(window, depth: 0)
        return layout
    }

    private static func capture(window: SimulatorOverlayTarget) async -> PixelBuffer? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let shareable = content.windows.first(where: { $0.windowID == window.windowID }) else {
                return nil
            }
            let filter = SCContentFilter(desktopIndependentWindow: shareable)
            let configuration = SCStreamConfiguration()
            let scale = CGFloat(filter.pointPixelScale)
            configuration.width = Int(window.frame.width * scale)
            configuration.height = Int(window.frame.height * scale)
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            return pixels(of: image)
        } catch {
            logError("Device Hub window capture failed: \(error)")
            return nil
        }
    }

    private static func pixels(of image: CGImage) -> PixelBuffer? {
        let bytesPerRow = image.width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * image.height)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        return drawn ? PixelBuffer(width: image.width, height: image.height, bytesPerRow: bytesPerRow, bytes: bytes) :
            nil
    }

    private static func rgb(_ pixels: PixelBuffer, x: Int, y: Int) -> (Int, Int, Int) {
        let offset = y * pixels.bytesPerRow + x * 4
        return (Int(pixels.bytes[offset]), Int(pixels.bytes[offset + 1]), Int(pixels.bytes[offset + 2]))
    }

    private static func differs(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Bool {
        abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2) > backgroundTolerance
    }
}
