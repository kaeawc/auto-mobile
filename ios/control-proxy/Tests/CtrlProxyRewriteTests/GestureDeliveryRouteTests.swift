@testable import CtrlProxyRewrite
import XCTest

/// #10858: a tap or swipe on a foreground app the runner did not pin is synthesized in screen
/// space instead of waiting on the rebound `XCUIApplication`.
final class GestureDeliveryRouteTests: XCTestCase {
    private let unpinned = GestureApplicationTarget.rebind(bundleId: "com.apple.Preferences")
    private let phone = GestureSize(width: 402, height: 874)

    private func geometry(
        app: GestureSize? = nil, screen: GestureSize? = nil, rotation: Int? = 0
    )
        -> GestureCoordinateGeometry
    {
        GestureCoordinateGeometry(
            app: app ?? phone, screen: screen ?? phone, observation: app ?? phone, rotation: rotation
        )
    }

    func testSynthesizesForUnpinnedFullScreenPortraitApp() {
        XCTAssertEqual(
            GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: geometry()),
            .synthesizedEventRecord(interfaceOrientation: 1)
        )
    }

    func testMapsObservedRotationToInterfaceOrientation() {
        let landscape = GestureSize(width: 874, height: 402)
        for (rotation, orientation) in [(1, 4), (2, 2), (3, 3)] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(
                    target: unpinned, forced: nil,
                    geometry: geometry(app: rotation == 2 ? phone : landscape, rotation: rotation)
                ),
                .synthesizedEventRecord(interfaceOrientation: orientation),
                "rotation \(rotation)"
            )
        }
    }

    func testKeepsXCUICoordinateForPinnedApp() {
        XCTAssertEqual(
            GestureDeliveryRoute.resolve(target: .keepPinned, forced: nil, geometry: geometry()), .xcuiCoordinate
        )
    }

    func testKeepsXCUICoordinateWhenAStrategyIsForced() {
        for forced in [TapCoordinateStrategy.legacy, .appRelative, .displayTargetedObserved] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(target: unpinned, forced: forced, geometry: geometry()),
                .xcuiCoordinate, "\(forced)"
            )
        }
    }

    func testKeepsXCUICoordinateWithoutAnObservationOfTheApp() {
        XCTAssertEqual(GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: nil), .xcuiCoordinate)
    }

    func testKeepsXCUICoordinateForMultiPanelOrInsetWindow() {
        let inset = geometry(app: GestureSize(width: 600, height: 700), screen: GestureSize(width: 1024, height: 1366))
        XCTAssertEqual(GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: inset), .xcuiCoordinate)
    }

    func testKeepsXCUICoordinateForInvalidSizesOrUnknownRotation() {
        let zero = GestureSize(width: 0, height: 0)
        for candidate in [geometry(app: zero), geometry(screen: zero), geometry(rotation: nil), geometry(rotation: 7)] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: candidate), .xcuiCoordinate
            )
        }
    }

    // MARK: - launchApp, then an external launch (#10858 original order)

    private let playground = "dev.jasonpearson.automobile.Playground"
    private let settings = "com.apple.Preferences"

    /// `launchApp` pins Playground; `simctl launch` brings Settings forward and observe moves the
    /// tracker. Every later gesture on Settings, not just the first, takes the synthesized route.
    func testExternallyLaunchedAppStaysUnpinnedAcrossGestures() {
        var pinned = GesturePinnedApplication()
        var tracker = ForegroundTracker()
        pinned.pin(playground)
        _ = tracker.switchForeground(app: nil, bundleId: playground, observe: true, now: 1)
        XCTAssertEqual(pinned.target(trackedBundleId: tracker.bundleId), .keepPinned)

        _ = tracker.switchForeground(app: nil, bundleId: settings, observe: true, now: 2)
        for gesture in ["tapOn General", "swipeOn up", "tapOn About"] {
            let target = pinned.target(trackedBundleId: tracker.bundleId)
            XCTAssertEqual(target, .rebind(bundleId: settings), gesture)
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: target, forced: nil, geometry: geometry()),
                .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil), gesture
            )
        }
        XCTAssertEqual(pinned.bundleId, playground, "resolving a gesture target must not re-pin")
    }

    /// Back on the pinned app the `XCUICoordinate` path returns; a new `launchApp` re-pins.
    func testPinnedAppKeepsXCUICoordinateAndRelaunchRepins() {
        var pinned = GesturePinnedApplication()
        pinned.pin(playground)
        XCTAssertEqual(
            GestureDeliveryRoute.decide(
                target: pinned.target(trackedBundleId: playground), forced: nil, geometry: geometry()
            ),
            .init(route: .xcuiCoordinate, fallback: .pinnedApp)
        )
        pinned.pin(settings)
        XCTAssertEqual(pinned.target(trackedBundleId: settings), .keepPinned)
        pinned.clear()
        XCTAssertEqual(pinned.target(trackedBundleId: settings), .rebind(bundleId: settings))
        XCTAssertEqual(pinned.target(trackedBundleId: nil), .keepPinned)
    }

    func testFallbackNamesWhyTheSynthesizedRouteWasSkipped() {
        let cases: [(GestureCoordinateGeometry?, TapCoordinateStrategy?, GestureDeliveryRoute.Fallback)] = [
            (nil, nil, .noObservation),
            (geometry(), .legacy, .forcedStrategy),
            (geometry(app: GestureSize(width: 0, height: 0)), nil, .invalidSize),
            (geometry(app: GestureSize(width: 600, height: 700), screen: GestureSize(width: 1024, height: 1366)),
             nil, .multiPanel),
            (geometry(rotation: nil), nil, .unknownRotation),
        ]
        for (candidate, forced, fallback) in cases {
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: unpinned, forced: forced, geometry: candidate),
                .init(route: .xcuiCoordinate, fallback: fallback), "\(fallback)"
            )
        }
    }
}
