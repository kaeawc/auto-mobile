import Foundation
import ObjCExceptionCatcher
import os
#if canImport(XCTest) && os(iOS)
    import UIKit
    import XCTest

    /// The legacy anchor stays exactly as supplied. Only a relative selection anchors on
    /// the observed application, since the legacy application's owner may be SpringBoard.
    @MainActor
    final class XCUIGestureCoordinateProvider: DisplayGestureProviding {
        struct Coordinate {
            let base: XCUICoordinate
            let resolved: XCUICoordinate
            let application: XCUIApplication
            /// Screen origin of an inset app window added to a point offset (#6635).
            let windowTranslation: GesturePoint?
        }

        private let app: XCUIApplication
        private let locator: any ElementLocating
        private var relativeApp: XCUIApplication?
        private var windowTranslation: GesturePoint?
        private let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "GesturePerformer")

        // Providers are created per gesture; share the reference across the runner process.
        private static let referenceScreenCache = ReferenceScreenCache {
            do {
                return try catchingObjCException {
                    let frame = XCUIApplication(bundleIdentifier: "com.apple.springboard").frame
                    return GestureSize(width: Double(frame.width), height: Double(frame.height))
                }
            } catch {
                let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "GesturePerformer")
                logger.warning("tap reference screen unavailable: \(error)")
                return nil
            }
        }

        init(app: XCUIApplication, locator: any ElementLocating) {
            self.app = app
            self.locator = locator
        }

        var cachedGeometry: GestureCoordinateGeometry? {
            guard let cached = locator.gestureCoordinateGeometry else { return nil }
            return cached.resolvingSinglePanel(reference: Self.referenceScreenCache.cachedScreen(for: cached)) ?? cached
        }

        var observedApplication: XCUIApplication {
            relativeApp ?? locator.foregroundBundleId.map { XCUIApplication(bundleIdentifier: $0) } ?? app
        }

        func displayInventory() -> GestureDisplayInventory {
            let screens = (ObjCExceptionCatcher_displayInventory() ?? [])
                .compactMap { entry -> TapDiagnostics.DisplayScreen? in
                    guard let displayId = entry["displayId"], let isMain = entry["isMain"] else { return nil }
                    return .init(displayId: displayId.uint64Value, isMain: isMain.boolValue)
                }
            // The observed app may differ from the legacy SpringBoard anchor.
            let target = observedApplication
            return GestureDisplayInventory(
                screens: screens, applicationDisplayId: ObjCExceptionCatcher_displayID(target)?.uint64Value,
                isPhoneIdiom: UIDevice.current.userInterfaceIdiom == .phone
            )
        }

        func synthesize(_ touch: DisplayTouch) throws -> Bool {
            var unavailable: ObjCBool = false
            var message: NSString?
            let succeeded = ObjCExceptionCatcher_synthesizeDisplayTouch(
                CGFloat(touch.start.x), CGFloat(touch.start.y), CGFloat(touch.end.x), CGFloat(touch.end.y),
                touch.pressDuration, touch.moveDuration, touch.displayId, touch.interfaceOrientation,
                &unavailable, &message
            )
            if succeeded { return true }
            guard unavailable.boolValue else {
                throw GesturePerformer.GestureError
                    .gestureFailed(message as String? ?? "display-targeted touch synthesis failed")
            }
            return false
        }

        func geometry() throws -> GestureCoordinateGeometry? {
            guard let cached = locator.gestureCoordinateGeometry else { return nil }
            // No extra platform reads for folded / ordinary single-panel observations.
            guard hasMultiPanelMismatch(app: cached.app, screen: cached.screen) else { return cached }
            let reference = Self.referenceScreenCache.screen(for: cached)
            if let corrected = cached.resolvingSinglePanel(reference: reference) { return corrected }
            do {
                return try catchingObjCException {
                    let target = locator.foregroundBundleId.map { XCUIApplication(bundleIdentifier: $0) } ?? app
                    relativeApp = target
                    let frame = target.frame
                    let screen = reference ?? GestureSize(
                        width: Double(UIScreen.main.bounds.width), height: Double(UIScreen.main.bounds.height)
                    )
                    let size = GestureSize(width: Double(frame.width), height: Double(frame.height))
                    // A changed app frame requires another observation before a relative mapping.
                    let sameFrame = abs(size.width - cached.app.width) <= 1 &&
                        abs(size.height - cached.app.height) <= 1
                    let observation = sameFrame ? cached.observation : GestureSize(width: 0, height: 0)
                    windowTranslation = readWindowTranslation(target, appFrame: frame)
                    let rotation = DeviceRotation.current() ?? cached.rotation
                    return GestureCoordinateGeometry(
                        app: size, screen: screen,
                        observation: observation,
                        rotation: GestureCoordinateGeometry.observationRotation(rotation, size: observation)
                    )
                }
            } catch {
                logger.warning("tap strategy geometry unavailable; using legacy: \(error)")
                return nil
            }
        }

        /// Only runs on the mismatch path: an app frame smaller than the screen. One extra query.
        private func readWindowTranslation(_ target: XCUIApplication, appFrame: CGRect) -> GesturePoint? {
            do {
                return try catchingObjCException {
                    let window = target.windows.firstMatch.frame
                    return windowedAppTranslation(
                        appOrigin: GesturePoint(x: Double(appFrame.minX), y: Double(appFrame.minY)),
                        appSize: GestureSize(width: Double(appFrame.width), height: Double(appFrame.height)),
                        windowOrigin: GesturePoint(x: Double(window.minX), y: Double(window.minY)),
                        windowSize: GestureSize(width: Double(window.width), height: Double(window.height))
                    )
                }
            } catch {
                logger.warning("app window origin unavailable; gestures stay app-frame relative: \(error)")
                return nil
            }
        }

        func coordinate(selection: GestureCoordinateSelection) throws -> Coordinate {
            try catchingObjCException {
                let target: XCUIApplication
                if selection.anchor == .legacyApplication {
                    target = app
                } else {
                    target = relativeApp ?? locator.foregroundBundleId
                        .map { XCUIApplication(bundleIdentifier: $0) } ?? app
                }
                let anchor = target.coordinate(withNormalizedOffset: CGVector(
                    dx: selection.normalized.x, dy: selection.normalized.y
                ))
                let translation = selection.windowTranslation(windowTranslation)
                let base = translation.map { anchor.withOffset(CGVector(dx: $0.x, dy: $0.y)) } ?? anchor
                let resolved = selection.offset.map { base.withOffset(CGVector(dx: $0.x, dy: $0.y)) } ?? base
                return Coordinate(base: base, resolved: resolved, application: target, windowTranslation: translation)
            }
        }

        func tap(_ coordinate: Coordinate, duration: TimeInterval) throws {
            try catchingObjCException {
                if duration > 0 {
                    coordinate.resolved.press(forDuration: duration)
                } else {
                    coordinate.resolved.tap()
                }
            }
        }

        func drag(
            _ start: Coordinate, to end: Coordinate, press: TimeInterval, velocity: Double?, hold: TimeInterval
        )
            throws
        {
            try catchingObjCException {
                start.resolved.press(
                    forDuration: press, thenDragTo: end.resolved,
                    withVelocity: velocity.map(XCUIGestureVelocity.init) ?? .default, thenHoldForDuration: hold
                )
            }
        }
    }
#endif
