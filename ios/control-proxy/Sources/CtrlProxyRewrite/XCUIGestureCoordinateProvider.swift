import Foundation
import os
#if canImport(XCTest) && os(iOS)
    import UIKit
    import XCTest

    /// The legacy anchor stays exactly as supplied. Only a relative selection anchors on
    /// the observed application, since the legacy application's owner may be SpringBoard.
    @MainActor
    final class XCUIGestureCoordinateProvider: GestureCoordinateProviding {
        struct Coordinate {
            let base: XCUICoordinate
            let resolved: XCUICoordinate
            let application: XCUIApplication
        }

        private let app: XCUIApplication
        private let locator: any ElementLocating
        private var relativeApp: XCUIApplication?
        private let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "GesturePerformer")

        init(app: XCUIApplication, locator: any ElementLocating) {
            self.app = app
            self.locator = locator
        }

        func geometry() throws -> GestureCoordinateGeometry? {
            guard let cached = locator.gestureCoordinateGeometry else { return nil }
            // No extra platform reads for folded / ordinary single-panel observations.
            guard hasMultiPanelMismatch(app: cached.app, screen: cached.screen) else { return cached }
            do {
                return try catchingObjCException {
                    let target = locator.foregroundBundleId.map { XCUIApplication(bundleIdentifier: $0) } ?? app
                    relativeApp = target
                    let frame = target.frame
                    let screen = UIScreen.main.bounds
                    let size = GestureSize(width: Double(frame.width), height: Double(frame.height))
                    // A changed app frame requires another observation before a relative mapping.
                    let sameFrame = abs(size.width - cached.app.width) <= 1 &&
                        abs(size.height - cached.app.height) <= 1
                    let observation = sameFrame ? cached.observation : GestureSize(width: 0, height: 0)
                    let rotation = DeviceRotation.current() ?? cached.rotation
                    return GestureCoordinateGeometry(
                        app: size, screen: GestureSize(width: Double(screen.width), height: Double(screen.height)),
                        observation: observation,
                        rotation: GestureCoordinateGeometry.observationRotation(rotation, size: observation)
                    )
                }
            } catch {
                logger.warning("tap strategy geometry unavailable; using legacy: \(error)")
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
                let base = target.coordinate(withNormalizedOffset: CGVector(
                    dx: selection.normalized.x, dy: selection.normalized.y
                ))
                let resolved = selection.offset.map { base.withOffset(CGVector(dx: $0.x, dy: $0.y)) } ?? base
                return Coordinate(base: base, resolved: resolved, application: target)
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

        func doubleTap(_ coordinate: Coordinate) throws {
            try catchingObjCException { coordinate.resolved.doubleTap() }
        }

        func press(_ coordinate: Coordinate, duration: TimeInterval) throws {
            try catchingObjCException { coordinate.resolved.press(forDuration: duration) }
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
