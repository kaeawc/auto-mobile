import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

#if canImport(XCTest) && os(iOS)
    extension GesturePerformer {
        // MARK: - Screenshots

        public func getScreenshot() throws -> Data {
            return try catchingObjCException {
                let screenshot = XCUIScreen.main.screenshot()
                return try self.nativeSizedPNGRepresentation(screenshot)
            }
        }

        public func getScreenshotCapture() throws -> ScreenshotCapture {
            return try catchingObjCException {
                let capture = DeviceRotation.capture { XCUIScreen.main.screenshot() }
                return try ScreenshotCapture(
                    data: self.nativeSizedPNGRepresentation(capture.value),
                    rotation: capture.rotation
                )
            }
        }

        private func nativeSizedPNGRepresentation(_ screenshot: XCUIScreenshot) throws -> Data {
            let original = screenshot.pngRepresentation
            guard let source = Self.pngDimensions(original) else {
                throw GestureError.gestureFailed("XCUITest returned an invalid PNG screenshot")
            }

            // XCUITest rounds odd native widths down by one pixel (#7384), and
            // UIScreen.nativeBounds carries the same truncated width. Derive the
            // framebuffer dimensions from SpringBoard's point-space frame and
            // nativeScale, then re-encode only when that exposes the mismatch.
            let frame = springboard.frame
            let nativeScale = UIScreen.main.nativeScale
            var target = (
                width: ElementBounds.clampedInt((frame.width * nativeScale).rounded()),
                height: ElementBounds.clampedInt((frame.height * nativeScale).rounded())
            )
            guard target.width > 0, target.height > 0 else {
                return original
            }
            if (source.width > source.height) != (target.width > target.height) {
                target = (width: target.height, height: target.width)
            }
            guard source != target else {
                return original
            }
            let widthDelta = target.width - source.width
            let heightDelta = target.height - source.height
            guard (widthDelta == 1 && heightDelta == 0) || (widthDelta == 0 && heightDelta == 1) else {
                throw GestureError.gestureFailed(
                    "XCUITest screenshot dimensions \(source.width)x\(source.height) do not match " +
                        "the native framebuffer \(target.width)x\(target.height); refusing to rescale an unexpected mismatch"
                )
            }

            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let targetSize = CGSize(width: target.width, height: target.height)
            let correctedImage = UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
                screenshot.image.draw(in: CGRect(origin: .zero, size: targetSize))
            }
            guard let corrected = correctedImage.pngData(),
                  let correctedDimensions = Self.pngDimensions(corrected),
                  correctedDimensions == target
            else {
                throw GestureError.gestureFailed(
                    "Failed to encode screenshot at native dimensions \(target.width)x\(target.height)"
                )
            }
            return corrected
        }

        private static func pngDimensions(_ data: Data) -> (width: Int, height: Int)? {
            let signature = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
            guard data.count >= 24, data.prefix(signature.count) == signature else {
                return nil
            }
            func uint32(at offset: Int) -> Int {
                data[offset ..< offset + 4].reduce(0) { ($0 << 8) | Int($1) }
            }
            return (width: uint32(at: 16), height: uint32(at: 20))
        }
    }
#endif
