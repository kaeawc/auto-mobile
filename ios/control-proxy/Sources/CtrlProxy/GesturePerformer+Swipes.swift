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
        // MARK: - Swipe Gestures

        public func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            let target = gestureApplicationTarget()
            if try deliverToUnpinnedForegroundApp(
                kind: .swipe, target: target, forced: nil, start: GesturePoint(x: startX, y: startY),
                end: GesturePoint(x: endX, y: endY), duration: duration
            ) {
                return
            }
            guard let app = gestureApplication(for: target) else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )
                let distance = hypot(endX - startX, endY - startY)
                let velocity = Self.swipeVelocity(distance: distance, duration: duration)

                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliver(
                    start: GesturePoint(x: startX, y: startY), end: GesturePoint(x: endX, y: endY),
                    press: 0.05, move: duration, velocity: velocity
                ) { _ in
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if factory.mismatch {
                    // The line describes the swipe's start point; it is not a tap (#8379).
                    var sample = TapDiagnostics(requested: .init(
                        x: startX, y: startY, durationMs: Self.diagnosticDurationMs(duration), mode: "swipe"
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(gesture: "swipe"), privacy: .public)")
                }
            }
        }

        /// App-independent event delivery avoids stale-app activation and lock-screen idle waits.
        public func lockScreenSwipe(
            startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
        )
            throws
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            // No XCUIApplication is resolved: the lock screen may leave the tracked app stale.
            let synthesized = try catchingObjCException { () -> Bool in
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                GesturePhaseDiagnostics.current?.begin("synthesizedGesture")
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let succeeded = ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
                    CGFloat(startX), CGFloat(startY), CGFloat(endX), CGFloat(endY),
                    1, 0, duration, orientation.rawValue, &symbolsUnavailable, &errorMessage
                )
                guard !succeeded else { return true }
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "lock-screen swipe synthesis failed")
                }
                return false
            }
            if !synthesized {
                // Availability fallback retains the existing XCUITest behavior and phase name.
                try swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
            }
        }

        public func multiFingerSwipe(
            startX: Double,
            startY: Double,
            endX: Double,
            endY: Double,
            fingerCount: Int,
            fingerSpacing: Double,
            duration: TimeInterval
        )
            throws
        {
            guard application != nil else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                let succeeded = ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
                    CGFloat(startX),
                    CGFloat(startY),
                    CGFloat(endX),
                    CGFloat(endY),
                    fingerCount,
                    CGFloat(fingerSpacing),
                    duration,
                    orientation.rawValue,
                    &symbolsUnavailable,
                    &errorMessage
                )

                if !succeeded {
                    // Unlike pinch (#2910) there is no public-API fallback to take
                    // here — for two or more fingers no XCUITest API delivers
                    // parallel simultaneous touch paths, and a single-finger
                    // substitute would be a different gesture. The availability
                    // signal therefore only distinguishes the failure message
                    // (#2952); see MultiFingerSwipeDiagnostics for the full
                    // rationale, including why the public `scroll(byDeltaX:deltaY:)`
                    // does not qualify despite being available on iOS.
                    throw GestureError.gestureFailed(
                        MultiFingerSwipeDiagnostics.failureMessage(
                            symbolsUnavailable: symbolsUnavailable.boolValue,
                            underlying: errorMessage as String? ?? "multi-finger swipe synthesis failed"
                        )
                    )
                }
            }
        }

        // MARK: - Path Gestures

        public func path(points: [PathGesturePoint]) throws {
            guard application != nil else {
                throw GestureError.noApplication
            }
            let cgPoints = points.map { CGPoint(x: $0.x, y: $0.y) }
            let offsets = points.map { TimeInterval($0.offsetMs) / 1000.0 }
            try catchingObjCException {
                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                let succeeded = ObjCExceptionCatcher_synthesizePath(
                    cgPoints, offsets, UInt(points.count), orientation.rawValue,
                    &symbolsUnavailable, &errorMessage
                )
                if !succeeded {
                    // No public XCUITest API follows an arbitrary polyline with timing, so there is
                    // no degraded fallback; report the OS/XCTest gap clearly.
                    let underlying = errorMessage as String? ?? "path gesture synthesis failed"
                    throw GestureError.gestureFailed(
                        symbolsUnavailable.boolValue
                            ? "private XCTest touch synthesis unavailable on this OS/XCTest version, "
                            + "and no public XCUITest API can follow a timed path. \(underlying)"
                            : underlying
                    )
                }
            }
        }

        // MARK: - Drag Gestures

        public func drag(
            startX: Double, startY: Double,
            endX: Double, endY: Double,
            pressDuration: TimeInterval,
            dragDuration: TimeInterval,
            holdDuration: TimeInterval
        )
            throws
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            let target = gestureApplicationTarget()
            if try deliverDragToUnpinnedForegroundApp(
                target: target, start: GesturePoint(x: startX, y: startY), end: GesturePoint(x: endX, y: endY),
                press: pressDuration, move: dragDuration, hold: holdDuration
            ) {
                return
            }
            guard let app = gestureApplication(for: target) else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                // The display-targeted route reaches an unfolded iPhone Duo's inner panel, which
                // an XCUICoordinate drag synthesized against the main (cover) screen misses.
                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )

                // XCUICoordinate's drag API takes a velocity (points/second), not a duration,
                // so honor the caller's dragDuration by converting it into the velocity that
                // covers the source→target distance in that time. This gives iOS the same
                // drag-speed control Android has. Fall back to .default when the duration or
                // distance is non-positive (avoids divide-by-zero / infinite velocity).
                let distance = hypot(endX - startX, endY - startY)
                let velocity: Double? = (dragDuration > 0 && distance > 0) ? distance / dragDuration : nil

                // Press, drag, and hold
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliver(
                    start: GesturePoint(x: startX, y: startY), end: GesturePoint(x: endX, y: endY),
                    press: pressDuration, move: dragDuration, hold: holdDuration, velocity: velocity
                ) { delivery in
                    logRelativeCoordinate(delivery.selection, gesture: "drag")
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if factory.mismatch {
                    var sample = TapDiagnostics(requested: .init(
                        x: startX, y: startY, durationMs: Self.diagnosticDurationMs(dragDuration), mode: "drag"
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(gesture: "drag"), privacy: .public)")
                }
            }
        }
    }
#endif
