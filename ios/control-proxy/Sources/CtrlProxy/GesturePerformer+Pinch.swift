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
        // MARK: - Pinch Gestures

        /// Main-screen two-finger pinch without an `XCUIApplication`; false when the private
        /// symbols are unavailable so the caller keeps its app-anchored path.
        private func deliverPinchToUnpinnedForegroundApp(
            center: GesturePoint, distanceStart: Double, distanceEnd: Double, rotationDegrees: Double,
            duration: TimeInterval, orientation: Int
        )
            throws -> Bool
        {
            try catchingObjCException { () -> Bool in
                GesturePhaseDiagnostics.current?.begin("synthesizedGesture")
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                let succeeded = ObjCExceptionCatcher_synthesizePinch(
                    CGFloat(center.x), CGFloat(center.y), CGFloat(distanceStart), CGFloat(distanceEnd),
                    CGFloat(rotationDegrees), duration, orientation, &symbolsUnavailable, &errorMessage
                )
                if succeeded { return true }
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "pinch synthesis failed")
                }
                return false
            }
        }

        @discardableResult
        public func pinch(
            centerX: Double,
            centerY: Double,
            distanceStart: Double,
            distanceEnd: Double,
            rotationDegrees: Double,
            duration: TimeInterval
        )
            throws -> PinchGesturePath
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            let target = gestureApplicationTarget()
            if let orientation = unpinnedSynthesisOrientation(kind: .pinch, target: target, forced: nil),
               try deliverPinchToUnpinnedForegroundApp(
                   center: GesturePoint(x: centerX, y: centerY), distanceStart: distanceStart,
                   distanceEnd: distanceEnd, rotationDegrees: rotationDegrees, duration: duration,
                   orientation: orientation
               )
            {
                return .eventPath
            }
            guard let app = gestureApplication(for: target) else {
                throw GestureError.noApplication
            }

            return try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                // An unfolded iPhone Duo shows the app on the inner panel, which a pinch synthesized
                // against the main (cover) screen misses; the display-targeted route reaches it.
                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliverPinch(
                    center: GesturePoint(x: centerX, y: centerY), distanceStart: distanceStart,
                    distanceEnd: distanceEnd, rotationDegrees: rotationDegrees, duration: duration
                ) { delivery in
                    logRelativeCoordinate(delivery.selection, gesture: "pinch")
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if factory.mismatch {
                    var sample = TapDiagnostics(requested: .init(
                        x: centerX, y: centerY, durationMs: Self.diagnosticDurationMs(duration), mode: "pinch"
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(gesture: "pinch"), privacy: .public)")
                }
                if delivery.synthesizedPoint != nil { return .eventPath }

                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                let succeeded = ObjCExceptionCatcher_synthesizePinch(
                    CGFloat(centerX),
                    CGFloat(centerY),
                    CGFloat(distanceStart),
                    CGFloat(distanceEnd),
                    CGFloat(rotationDegrees),
                    duration,
                    orientation.rawValue,
                    &symbolsUnavailable,
                    &errorMessage
                )

                if succeeded {
                    return .eventPath
                }

                // Only degrade to the public API when the private symbols are
                // genuinely absent. A real synthesis error still surfaces as a
                // structured failure (issue #2910).
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "pinch synthesis failed")
                }

                // Public element-anchored fallback: honors scale/velocity but
                // centers on the SpringBoard anchor, so it ignores centerX/centerY
                // and rotationDegrees (the public API has no center or rotation).
                //
                // This branch runs only on-device. Off-device coverage is split
                // across PinchFallbackTests (the scale/velocity math) and
                // ObjCExceptionBridgeTests (the symbolsUnavailable signal that
                // routes here); the live app.pinch call itself is device-only.
                let params = PinchFallback.parameters(
                    distanceStart: distanceStart,
                    distanceEnd: distanceEnd,
                    duration: duration
                )
                app.pinch(withScale: params.scale, velocity: params.velocity)
                return .elementAnchored
            }
        }
    }
#endif
