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
        public func openRecentApps() async throws -> Bool {
            try await openRecentAppsReportingRoute().visible
        }

        public func openRecentAppsReportingRoute() async throws -> RecentAppsOutcome {
            #if targetEnvironment(simulator)
                return try await RecentAppsNavigation.openSimulator(
                    clock: keyboardClock, isVisible: { self.isAppSwitcherVisible() },
                    doubleHome: { try await self.pressSimulatorHomeTwice() }
                )
            #else
                if isAppSwitcherVisible() {
                    return RecentAppsOutcome(visible: true, route: "already-open")
                }
                return try openRecentAppsByDragging()
            #endif
        }

        private func isAppSwitcherVisible() -> Bool {
            catchingObjCExceptionNonThrowing({
                AppSwitcherDetector.isVisible(in: springboard)
            }, fallback: false)
        }

        private func openRecentAppsByDragging() throws -> RecentAppsOutcome {
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }

            var route = "xcui-drag"
            try catchingObjCException {
                let frame = app.frame
                guard frame.width > 0, frame.height > 0 else {
                    throw GestureError.gestureFailed("Cannot determine application frame for recent apps gesture")
                }

                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )
                if factory.mismatch, let size = factory.geometry?.observation, size.isValid {
                    let edge = NavigationEdgeGesture.recent(size: size)
                    let delivery = try factory.deliver(
                        start: edge.start, end: edge.end, press: edge.press, move: edge.move,
                        hold: edge.hold, velocity: edge.velocity
                    )
                    if delivery.synthesizedPoint != nil { route = "display-targeted-drag" }
                    return
                }

                let edge = NavigationEdgeGesture.recent(size: GestureSize(
                    width: Double(frame.width),
                    height: Double(frame.height)
                ))
                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: edge.start.x, dy: edge.start.y))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: edge.end.x, dy: edge.end.y))
                let velocity = edge.velocity.map(XCUIGestureVelocity.init) ?? .default

                startCoordinate.press(
                    forDuration: edge.press,
                    thenDragTo: endCoordinate,
                    withVelocity: velocity,
                    thenHoldForDuration: edge.hold
                )
            }

            return RecentAppsOutcome(visible: isAppSwitcherVisible(), route: route)
        }

        // MARK: - App Control

        public func launchApp(bundleId: String) throws {
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.launch()
            }
        }

        public func terminateApp(bundleId: String) throws {
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.terminate()
            }
        }

        public func activateApp(bundleId: String) throws {
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.activate()
            }
        }

        // MARK: - App Privacy Permissions

        /// Reset each named resource's authorization to not-determined on the target
        /// app. `resetAuthorizationStatus(for:)` (Xcode 11.4+) works on real devices,
        /// not just simulators — the whole point of #2491. An AutoMobile permission
        /// with no `XCUIProtectedResource` equivalent (e.g. `siri`, `motion`) throws
        /// `invalidParameter` so the caller reports it as a per-permission failure.
        /// The aggregate `all` keyword expands to every unique resettable
        /// `XCUIProtectedResource` value before calling XCTest.
        public func resetAuthorizations(bundleId: String, resources: [String]) throws {
            // Throws on the first unmapped resource, so a mixed batch applies the
            // resets before it and then fails as a whole. The TS client sends one
            // permission per request, so each is isolated and accounted per-permission;
            // this only matters for a hypothetical multi-resource single request.
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                var resetResourceNames = Set<String>()
                for raw in resources {
                    guard let resettableResourceNames = Self.expandedPrivacyResourceNames(for: raw) else {
                        throw CommandError.invalidParameter("permission", raw)
                    }
                    for resettableResourceName in resettableResourceNames {
                        let canonicalResourceName = Self.canonicalPrivacyResourceName(for: resettableResourceName)
                        if resetResourceNames.contains(canonicalResourceName) {
                            continue
                        }
                        guard let resource = Self.protectedResource(for: resettableResourceName) else {
                            throw CommandError.invalidParameter("permission", resettableResourceName)
                        }
                        resetResourceNames.insert(canonicalResourceName)
                        app.resetAuthorizationStatus(for: resource)
                    }
                }
            }
        }
    }
#endif

/// Simulator navigation is a toggle, so retries require a fresh negative visibility check.
/// The clock and dispatch seam keep the bounded policy testable without XCTest UI or devices.
@MainActor
enum RecentAppsNavigation {
    static func openSimulator<C: Clock>(
        clock: C,
        isVisible: () -> Bool,
        doubleHome: () async throws -> Void
    )
        async throws -> RecentAppsOutcome where C.Duration == Duration
    {
        var dispatched = false
        for _ in 0 ..< 2 {
            try Task.checkCancellation()
            if isVisible() {
                return RecentAppsOutcome(visible: true, route: dispatched ? "sim-hid-home-double" : "already-open")
            }
            try await doubleHome()
            dispatched = true
            if try await KeyboardWait.visibility(
                clock: clock, expected: true, timeout: .milliseconds(1500),
                interval: .milliseconds(100), probe: isVisible
            ) {
                return RecentAppsOutcome(visible: true, route: "sim-hid-home-double")
            }
        }
        return RecentAppsOutcome(visible: false, route: "sim-hid-home-double")
    }
}
